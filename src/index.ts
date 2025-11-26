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
      
      // Execution log to capture function calls
      const executionLog: Array<{ fn: string; args: any; result: any }> = [];
      
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

        // Bridge tool bindings into isolate with logging
        for (const [name, fn] of Object.entries(bindings)) {
          await context.evalClosure(
            `global[${JSON.stringify(name)}] = (...args) => $0.apply(undefined, args, { arguments: { copy: true }, result: { promise: true, copy: true } });`,
            [ new ivm.Reference(async (...args: any[]) => {
              try {
                const result = await fn(...args);
                executionLog.push({ fn: name, args, result });
                return result;
              } catch (error: any) {
                const errorMsg = error?.message || String(error);
                executionLog.push({ fn: name, args, result: `Error: ${errorMsg}` });
                throw error;
              }
            }) ],
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
            new ivm.Reference((res: any) => { 
              if (!finished) { 
                finished = true; 
                clearTimeout(wallTimer); 
                cleanup(); 
                // Format execution log and final result
                const formattedResult = this.formatExecutionResult(executionLog, res);
                resolve(formattedResult); 
              } 
            }),
            new ivm.Reference((msg: string) => { 
              if (!finished) { 
                finished = true; 
                clearTimeout(wallTimer); 
                cleanup(); 
                // Include execution log even on error
                const formattedError = this.formatExecutionResult(executionLog, null, msg);
                reject(new Error(formattedError)); 
              } 
            }),
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

  /**
   * Format execution log and final result in an LLM-friendly format
   */
  private formatExecutionResult(log: Array<{ fn: string; args: any; result: any }>, finalResult: any, error?: string): string {
    const lines: string[] = [];
    
    // Add execution log
    if (log.length > 0) {
      lines.push('Execution trace:');
      for (const entry of log) {
        const argsStr = JSON.stringify(entry.args);
        const resultStr = typeof entry.result === 'string' 
          ? entry.result 
          : JSON.stringify(entry.result);
        lines.push(`  ${entry.fn}(${argsStr}) → ${resultStr}`);
      }
      lines.push('');
    }
    
    // Add final result or error
    if (error) {
      lines.push(`Script error: ${error}`);
    } else if (finalResult !== undefined && finalResult !== null) {
      const resultStr = typeof finalResult === 'string'
        ? finalResult
        : JSON.stringify(finalResult);
      lines.push(`Final result: ${resultStr}`);
    }
    
    return lines.join('\n');
  }
}

/**
 * Sanitize tool name to be a valid JavaScript identifier
 * Converts kebab-case and other non-JS-friendly characters to underscores
 * This is needed for MCP tools which often use kebab-case naming
 */
function sanitizeToolName(name: string): string {
  // Replace any character that's not alphanumeric, underscore, or dollar sign with underscore
  return name.replace(/[^a-zA-Z0-9_$]/g, '_');
}

function extractToolBindings(tools: Tools): Record<string, Function> {
  const bindings: Record<string, Function> = {};

  for (const [name, tool] of Object.entries(tools)) {
    // Sanitize tool name to ensure it's a valid JavaScript identifier
    const sanitizedName = sanitizeToolName(name);
    bindings[sanitizedName] = tool.execute;
  }

  return bindings;
}

function generateCodeSystemPrompt(tools: Tools): string {
  // Convert JSON Schema (or Zod schema) to a readable type string
  function jsonSchemaToTypeString(schema: any): string {
    if (!schema) return 'unknown';
    
    // Handle Zod v4 toJSONSchema format (has 'def' and 'type' but not standard JSON Schema)
    if (schema.def && schema.type) {
      // Handle Zod optional wrapper - unwrap to innerType
      if (schema.type === 'optional') {
        const innerType = schema.def.innerType || schema.innerType;
        return jsonSchemaToTypeString(innerType);
      }
      
      // Handle Zod nullable wrapper - unwrap to innerType
      if (schema.type === 'nullable') {
        const innerType = schema.def.innerType || schema.innerType;
        return jsonSchemaToTypeString(innerType);
      }
      
      // Handle Zod array
      if (schema.type === 'array' && (schema.element || schema.def.element)) {
        const element = schema.element || schema.def.element;
        return `${jsonSchemaToTypeString(element)}[]`;
      }
      
      // Handle Zod object
      if (schema.type === 'object' && schema.def.shape) {
        const entries = Object.entries(schema.def.shape).map(([k, v]: [string, any]) => 
          `${k}: ${jsonSchemaToTypeString(v)}`
        );
        return `{ ${entries.join(', ')} }`;
      }
      
      // Handle primitive types
      if (schema.type === 'string') return 'string';
      if (schema.type === 'number') return 'number';
      if (schema.type === 'boolean') return 'boolean';
    }
    
    // Standard JSON Schema format
    if (schema.type === 'object' && schema.properties) {
      const entries = Object.entries(schema.properties).map(([k, v]: [string, any]) => 
        `${k}: ${jsonSchemaToTypeString(v)}`
      );
      return `{ ${entries.join(', ')} }`;
    }
    
    if (schema.type === 'array' && schema.items) {
      return `${jsonSchemaToTypeString(schema.items)}[]`;
    }
    
    if (schema.type === 'string') {
      if (schema.enum) {
        return schema.enum.map((v: string) => JSON.stringify(v)).join(' | ');
      }
      return 'string';
    }
    
    if (schema.type === 'number' || schema.type === 'integer') return 'number';
    if (schema.type === 'boolean') return 'boolean';
    if (schema.type === 'null') return 'null';
    
    if (schema.anyOf) {
      // Filter out null types for cleaner display
      const types = schema.anyOf.filter((s: any) => s.type !== 'null');
      if (types.length === 1) {
        return jsonSchemaToTypeString(types[0]);
      }
      return schema.anyOf.map(jsonSchemaToTypeString).join(' | ');
    }
    
    if (schema.oneOf) {
      return schema.oneOf.map(jsonSchemaToTypeString).join(' | ');
    }
    
    // Handle array of types (e.g., ["string", "null"])
    if (Array.isArray(schema.type)) {
      const types = schema.type.filter((t: string) => t !== 'null');
      if (types.length === 1) return types[0];
      return types.join(' | ');
    }
    
    return 'unknown';
  }

  function getParamEntries(tool: ToolDefinition): { name: string; type: string; optional?: boolean }[] {
    const schema = tool.parameters || tool.inputSchema;
    if (!schema) return [];
    
    try {
      // Convert Zod schema to JSON Schema using Zod v4's built-in method
      let jsonSchema: any;
      if (typeof schema === 'object' && 'type' in schema && typeof schema.type === 'string') {
        // Already a JSON schema
        jsonSchema = schema;
      } else {
        // Convert Zod to JSON Schema using built-in toJSONSchema (Zod v4+)
        jsonSchema = (z as any).toJSONSchema(schema);
      }
      
      // Extract parameters from Zod v4 toJSONSchema format (has 'def.shape')
      if (jsonSchema.type === 'object' && jsonSchema.def && jsonSchema.def.shape) {
        const shape = jsonSchema.def.shape;
        const required: string[] = Array.isArray(jsonSchema.def.required) ? jsonSchema.def.required : [];
        return Object.entries(shape).map(([key, prop]: [string, any]) => {
          const type = jsonSchemaToTypeString(prop);
          const optional = !required.includes(key);
          return { name: key, type, optional };
        });
      }
      
      // Extract parameters from standard JSON Schema format (has 'properties')
      if (jsonSchema.type === 'object' && jsonSchema.properties) {
        const required: string[] = Array.isArray(jsonSchema.required) ? jsonSchema.required : [];
        return Object.entries(jsonSchema.properties).map(([key, prop]: [string, any]) => {
          const type = jsonSchemaToTypeString(prop);
          const optional = !required.includes(key);
          return { name: key, type, optional };
        });
      }
      
      return [];
    } catch (err) {
      console.error('[getParamEntries] Error processing schema:', err);
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
      
      // Convert Zod schema to JSON Schema using Zod v4's built-in method
      let jsonSchema: any;
      if (typeof schema === 'object' && 'type' in schema && typeof schema.type === 'string') {
        // Already a JSON schema
        jsonSchema = schema;
      } else {
        // Convert Zod to JSON Schema using built-in toJSONSchema (Zod v4+)
        jsonSchema = (z as any).toJSONSchema(schema);
      }
      
      const typeStr = jsonSchemaToTypeString(jsonSchema);
      return typeStr ? `: ${formatType(typeStr)}` : '';
    } catch {
      return '';
    }
  }

  const toolDescriptions = Object.entries(tools)
    .map(([name, tool]) => {
      // Use sanitized name in documentation to match what's available in the sandbox
      const sanitizedName = sanitizeToolName(name);
      const params = getParamEntries(tool);
      const returns = getReturnSignature(tool);
      const lines: string[] = [];
      lines.push(`\n## ${sanitizedName}( params )`);
      lines.push(`  - ${tool.description}`);
      if (params.length > 0) {
        lines.push(`  - params <object>:`);
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
You can take action by writing server-side JavaScript using the following SDK. 

## Runtime Environment

- NodeJS V8 isolate secure sandboxed environment
- \`document\` and \`window\` are undefined. 
- This is not a browser environment, so DOM APIs are NOT available
- The context is async, so you can use \`await\` directly

## Available Functions

- The following functions are **directly available in scope** - no imports or destructuring needed:
- These functions have bindings to the chrome extension environment

# SDK
${toolDescriptions}

## Usage Notes

- **Functions are in scope**: Call them directly (e.g. \`await click(...)\`). Do NOT destructure from \`globalThis\` or \`global\`.
- **Already async**: Your script runs in an async context. Use \`await\` directly. Do NOT wrap in \`(async () => { ... })()\`.
- **Return values**: Use \`return\` to return data from your script.
- **Don't use try/catch**: We want original errors to be thrown. Use \`.catch()\` to handle errors only if errors are expected and you want to handle them gracefully.

# Example

\`\`\`yaml
toolName: runToolScript
args:
  description: Getting user location and fetching weather...
  script: const location = await getUserLocation();\\nconst weather = await getWeather({ location });\\nreturn { location, weather };
\`\`\`
</Tool Calling SDK>
`;

  return prompt;
}

export function toolScripting(aiFunction: Function, options: CodeModeOptions = {}) {
  return async function(config: any) {
    const { tools, system = '', scriptMetadataCallback, scriptResultCallback, logEnhancedSystemPrompt = false, ...restConfig } = config;
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

    if (logEnhancedSystemPrompt) {
      console.log('[toolScripting] Enhanced System Prompt:\n', enhancedSystem);
    }

    // Provide exactly one tool to the SDK: runToolScript
    const singleTool = {
      runToolScript: {
        description: 'Execute the provided tool script with available functions',
        inputSchema: z.object({ 
          description: z.string().describe('Brief human-friendly description of what this script does'),
          script: z.string().describe('The JavaScript code to execute')
        }),
        execute: async ({ description, script }: { description: string; script: string }) => {
          // Notify about script execution start with description
          if (scriptMetadataCallback) {
            scriptMetadataCallback({ description, script });
          }
          
          const result = await sandbox.execute(script, bindings);
          
          // Debug logging
          console.log('[toolScripting] Script execution complete, result type:', typeof result, result === undefined ? 'UNDEFINED!' : result === null ? 'NULL!' : `length: ${(result as any)?.length || 'N/A'}`);
          
          // Notify about script execution result
          if (scriptResultCallback) {
            scriptResultCallback(result);
          }
          
          // Return just the execution result (description already streamed to client)
          return result;
        }
      }
    } as Tools;

    // Call original AI function with enhanced system prompt and single tool
    return aiFunction({
      ...restConfig,
      tools: singleTool,
      system: enhancedSystem,
    });
  };
}
