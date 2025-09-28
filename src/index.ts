import ivm from 'isolated-vm';

export interface CodeModeOptions {
  timeout?: number;
  sandbox?: {
    allowConsole?: boolean;
    maxMemory?: number;
  };
  onCodeGenerated?: (code: string) => void;
  onCodeExecuted?: (result: any) => void;
  onError?: (error: Error) => void;
}

export interface ToolDefinition {
  description: string;
  inputSchema: any;
  execute: (...args: any[]) => Promise<any> | any;
}

export interface Tools {
  [key: string]: ToolDefinition;
}

class CodeExecutionSandbox {
  private timeout: number;
  private allowConsole: boolean;
  private maxMemory: number;

  constructor(options: CodeModeOptions = {}) {
    this.timeout = options.timeout || 30000;
    this.allowConsole = options.sandbox?.allowConsole ?? true;
    this.maxMemory = options.sandbox?.maxMemory || 128 * 1024 * 1024; // 128MB
  }

  async execute(code: string, bindings: Record<string, Function>): Promise<any> {
    const memoryLimitMb = Math.max(8, Math.ceil(this.maxMemory / (1024 * 1024)));
    
    return new Promise(async (resolve, reject) => {
      const isolate = new ivm.Isolate({ memoryLimit: memoryLimitMb });
      let finished = false;
      const cleanup = () => {
        try { isolate.dispose(); } catch {}
      };
      const wallTimer = setTimeout(() => {
        if (!finished) {
          finished = true;
          cleanup();
          reject(new Error('Code execution timed out'));
        }
      }, this.timeout);

      try {
        const context = await isolate.createContext();
        const jail = context.global;
        await jail.set('global', jail.derefInto());

        // Console bridging
        if (this.allowConsole) {
          await context.evalClosure(
            `global.console = {
              log: (...args) => $0.apply(undefined, args, { arguments: { copy: true } }),
              error: (...args) => $1.apply(undefined, args, { arguments: { copy: true } }),
              warn: (...args) => $2.apply(undefined, args, { arguments: { copy: true } })
            };`,
            [
              new ivm.Reference((...args: any[]) => console.log('[sandbox]', ...args)),
              new ivm.Reference((...args: any[]) => console.error('[sandbox]', ...args)),
              new ivm.Reference((...args: any[]) => console.warn('[sandbox]', ...args)),
            ],
          );
        } else {
          await context.eval(`global.console = { log: () => {}, error: () => {}, warn: () => {} };`);
        }

        // Timers bridging (basic)
        await context.evalClosure(
          `global.setTimeout = (fn, ms, ...args) => {
             return $0.apply(undefined, [fn, ms, args], { arguments: { reference: true, copy: true } });
           };
           global.clearTimeout = (id) => $1.apply(undefined, [id], { arguments: { copy: true } });`,
          [
            new ivm.Reference((fnRef: any, ms: number, args: any[]) => {
              const id = setTimeout(() => {
                try {
                  fnRef.apply(undefined, args, { arguments: { copy: true } });
                } catch {}
              }, ms);
              return id as unknown as number;
            }),
            new ivm.Reference((id: any) => clearTimeout(id)),
          ],
        );

        // Bridge tool bindings into isolate
        for (const [name, fn] of Object.entries(bindings)) {
          await context.evalClosure(
            `global[${JSON.stringify(name)}] = (...args) => $0.apply(undefined, args, { arguments: { copy: true }, result: { promise: true, copy: true } });`,
            [ new ivm.Reference(fn) ],
          );
        }

        // Execute wrapped async code and pipe result/errors to host
        const runPromise = context.evalClosure(
          `;(async () => {
              try {
                const __result = await (async () => { ${code} })();
                $0.applyIgnored(undefined, [ __result ], { arguments: { copy: true } });
              } catch (e) {
                const msg = e && e.message ? e.message : String(e);
                $1.applyIgnored(undefined, [ msg ], { arguments: { copy: true } });
              }
            })();`,
          [
            new ivm.Reference((res: any) => { if (!finished) { finished = true; clearTimeout(wallTimer); cleanup(); resolve(res); } }),
            new ivm.Reference((msg: string) => { if (!finished) { finished = true; clearTimeout(wallTimer); cleanup(); reject(new Error(msg)); } }),
          ],
          { timeout: this.timeout },
        );
        Promise.resolve(runPromise).catch(() => {});
      } catch (err: any) {
        if (!finished) {
          finished = true;
          clearTimeout(wallTimer);
          cleanup();
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
    });
  }
}

function extractToolBindings(tools: Tools): Record<string, Function> {
  const bindings: Record<string, Function> = {};
  
  for (const [name, tool] of Object.entries(tools)) {
    bindings[name] = tool.execute;
  }
  
  return bindings;
}

function generateCodeSystemPrompt(tools: Tools): string {
  const toolDescriptions = Object.entries(tools)
    .map(([name, tool]) => `- ${name}(): ${tool.description}`)
    .join('\n');

  return `
You can accomplish tasks by writing JavaScript code using the available functions.

Available functions:
${toolDescriptions}

When you want to use code mode, write JavaScript code in a code block:
\`\`\`javascript
// Your code here
const result = await someFunction();
return result;
\`\`\`

Use code mode for:
- Multiple function calls
- Data processing between calls
- Conditional logic
- Complex workflows
`.trim();
}

function extractCodeFromResponse(text: string): string | null {
  const codeMatch = text.match(/```(?:javascript|js)\n([\s\S]*?)\n```/);
  return codeMatch ? codeMatch[1].trim() : null;
}

export function codeMode(aiFunction: Function, options: CodeModeOptions = {}) {
  return async function(config: any) {
    const { tools, system = '', ...restConfig } = config;
    
    if (!tools) {
      throw new Error('Tools are required for code mode');
    }

    // Extract tool bindings
    const bindings = extractToolBindings(tools);
    
    // Create execution sandbox
    const sandbox = new CodeExecutionSandbox(options);
    
    // Enhanced system prompt
    const codeSystemPrompt = generateCodeSystemPrompt(tools);
    const enhancedSystem = system ? `${system}\n\n${codeSystemPrompt}` : codeSystemPrompt;
    
    // Call original AI function with enhanced system prompt
    const result = await aiFunction({
      ...restConfig,
      tools, // Keep original tools for fallback
      system: enhancedSystem,
    });

    // If it's a streaming result, we need to handle it differently
    if (result.textStream || result.fullStream) {
      return result; // Return as-is for now, streaming support can be added later
    }

    // For non-streaming results, check for code execution
    if (result.text) {
      const code = extractCodeFromResponse(result.text);
      
      if (code) {
        try {
          options.onCodeGenerated?.(code);
          
          const executionResult = await sandbox.execute(code, bindings);
          
          options.onCodeExecuted?.(executionResult);
          
          return {
            ...result,
            codeExecuted: true,
            executionResult,
            generatedCode: code,
          };
        } catch (error) {
          options.onError?.(error as Error);
          
          return {
            ...result,
            codeExecuted: false,
            executionError: (error as Error).message,
            generatedCode: code,
          };
        }
      }
    }

    return result;
  };
}
