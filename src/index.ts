import ivm from 'isolated-vm';
import { z } from 'zod';

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
  parameters?: any;
  outputSchema?: any;
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
  function zodTypeToString(schema: any): string {
    if (!schema) return 'unknown';
    // Zod object
    if (schema instanceof z.ZodObject) {
      const shape = schema.shape;
      const entries = Object.entries(shape).map(([k, v]) => `${k}: ${zodTypeToString(v)}`);
      return `{ ${entries.join(', ')} }`;
    }
    if (schema instanceof z.ZodString) return 'string';
    if (schema instanceof z.ZodNumber) return 'number';
    if (schema instanceof z.ZodBoolean) return 'boolean';
    if (schema instanceof z.ZodArray) return `${zodTypeToString(schema.element)}[]`;
    if (schema instanceof z.ZodOptional) return `${zodTypeToString(schema.unwrap())} | undefined`;
    if (schema instanceof z.ZodUnion) return schema._def.options.map(zodTypeToString).join(' | ');
    if (schema instanceof z.ZodLiteral) return JSON.stringify(schema._def.value);
    if (schema instanceof z.ZodEnum) return schema._def.values.map((v: string) => JSON.stringify(v)).join(' | ');
    return 'unknown';
  }

  function jsonSchemaToString(js: any): string {
    if (!js) return 'unknown';
    if (js.type === 'object' && js.properties) {
      const entries = Object.entries(js.properties).map(([k, v]: [string, any]) => `${k}: ${jsonSchemaToString(v)}`);
      return `{ ${entries.join(', ')} }`;
    }
    if (js.type === 'array') {
      const t = jsonSchemaToString(js.items);
      return `${t}[]`;
    }
    if (Array.isArray(js.enum)) {
      return js.enum.map((v: any) => JSON.stringify(v)).join(' | ');
    }
    if (typeof js === 'string') return js;
    return js.type || 'unknown';
  }

  function getParamEntries(tool: ToolDefinition): { name: string; type: string; optional?: boolean }[] {
    const schema = tool.parameters || tool.inputSchema;
    if (!schema) return [];
    try {
      // Zod object
      if (schema instanceof z.ZodObject) {
        const shape = schema.shape;
        return Object.entries(shape).map(([key, val]: [string, any]) => {
          let optional = false;
          let inner = val;
          if (val instanceof z.ZodOptional) {
            optional = true;
            inner = val.unwrap();
          }
          return { name: key, type: zodTypeToString(inner), optional };
        });
      }
      // JSON schema object
      if (schema && schema.type === 'object' && schema.properties) {
        const required: string[] = Array.isArray(schema.required) ? schema.required : [];
        return Object.entries(schema.properties).map(([key, prop]: [string, any]) => {
          const type = jsonSchemaToString(prop);
          const optional = !required.includes(key);
          return { name: key, type, optional };
        });
      }
      return [];
    } catch {
      return [];
    }
  }

  function getReturnSignature(tool: ToolDefinition): string {
    const schema = tool.outputSchema;
    if (!schema) return '';
    try {
      const formatType = (s: string) => {
        let out = s;
        const tokens = ['string', 'number', 'boolean', 'null', 'undefined'];
        for (const t of tokens) {
          const re = new RegExp(`\\b${t}\\b`, 'g');
          out = out.replace(re, `<${t}>`);
        }
        return out;
      };
      if (schema && typeof schema === 'object' && '_def' in schema) {
        const typeStr = zodTypeToString(schema);
        return `: ${formatType(typeStr)}`;
      }
      const typeStr = jsonSchemaToString(schema);
      return typeStr ? `: ${formatType(typeStr)}` : '';
    } catch {
      return '';
    }
  }

  const toolDescriptions = Object.entries(tools)
    .map(([name, tool]) => {
      const params = getParamEntries(tool);
      const returns = getReturnSignature(tool);
      const lines: string[] = [];
      lines.push(`\n## ${name} -- ${tool.description}`);
      if (params.length > 0) {
        lines.push(`  - params:`);
        for (const p of params) {
          const t = (p.type || '').trim();
          const typeDisplay = t.startsWith('{') ? t : `<${t}>`;
          lines.push(`    - ${p.name} ${typeDisplay}${p.optional ? ' (optional)' : ''}`);
        }
      }
      if (returns) {
        lines.push(`  - returns${returns}`);
      }
      return lines.join('\n');
    })
    .join('\n');

  const prompt = `
<Tool Calling SDK>
You can take action by writing JavaScript using the following SDK.

# SDK
${toolDescriptions}

# Example

\`\`\`yaml
toolName: runToolScript
args:
  script: const location = await getUserLocation();\\nconst weather = await getWeather({ location });\\nreturn { location, weather };
\`\`\`
</Tool Calling SDK>
`;

  return prompt;
}

export function toolScripting(aiFunction: Function, options: CodeModeOptions = {}) {
  return async function(config: any) {
    const { tools, system = '', ...restConfig } = config;
    const toolsObj: Tools = tools || {} as Tools;

    // Extract tool bindings
    const bindings = extractToolBindings(toolsObj);
    
    // Create execution sandbox
    const sandbox = new CodeExecutionSandbox(options);
    
    // Enhanced system prompt (omit Tool Calling SDK if there are no tools)
    const hasTools = Object.keys(toolsObj).length > 0;
    const codeSystemPrompt = hasTools ? generateCodeSystemPrompt(toolsObj) : '';
    const enhancedSystem = hasTools
      ? (system ? `${system}\n\n${codeSystemPrompt}` : codeSystemPrompt)
      : system;

    if (enhancedSystem) console.log(enhancedSystem);
    
    // Provide exactly one tool to the SDK: runToolScript
    const singleTool = {
      runToolScript: {
        description: 'Execute the provided tool script with available functions',
        inputSchema: z.object({ script: z.string() }),
        execute: async ({ script }: { script: string }) => {
          return await sandbox.execute(script, bindings);
        }
      }
    } as Tools;

    // Call original AI function with enhanced system prompt and single tool
    return aiFunction({
      ...restConfig,
      tools: singleTool,
      toolChoice: 'auto',
      system: enhancedSystem,
    });
  };
}
