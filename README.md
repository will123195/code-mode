# tool-script

Plug-n-play "code mode" tool call scripting for Vercel AI SDK

[![npm version](https://badge.fury.io/js/code-mode.svg)](https://badge.fury.io/js/tool-script)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Inspired by [Cloudflare's Code Mode](https://blog.cloudflare.com/code-mode/)** - LLMs are better at writing JavaScript than using synthetic tool calling syntax.

## Installation

```bash
npm install ai tool-script
```

## Usage

```javascript
import { z } from 'zod';
import { streamText, tool } from 'ai';
import { toolScript } from 'tool-script';

const tools = {
  getUserLocation: tool({
    description: 'Get user current location',
    inputSchema: z.object({}),
    // outputSchema: z.string(),
    execute: async () => 'San Francisco, CA',
  }),
  getWeather: tool({
    description: 'Get weather for a location',
    inputSchema: z.object({
      location: z.string(),
    }),
    outputSchema: z.object({ // optionally provide outputSchema to help the LLM compose tool calls
      location: z.string(),
      temperature: z.integer(),
      condition: z.string(),
    }),
    execute: async ({ location }) => {
      return { location, temperature: 65, condition: 'foggy' };
    },
  }),
};

const streamTextWithToolScript = toolScript(streamText)

// Just wrap your existing streamText call
const result = await streamTextWithToolScript({
  model: 'openai/gpt-5',
  tools,
  messages: [
    { role: 'assistant', content: 'How can I help?' },
    { role: 'user', content: 'How is the weather?' },
  ],
});
```

## How it works

1. **Extracts** your tool `execute` functions automatically
2. **LLM Generates** JavaScript code instead of tool calls
3. **Executes** code in secure sandbox with tool bindings
4. **Returns** whatever the generated code returns

## Why Code Mode?

**Tool Scripts > Tool Calls**

- 🧠 **Better** - LLMs excel at JavaScript vs synthetic tool syntax
- 🔧 **Composable** - Logic and conditionals between tool calls
- 🔒 **Secure** - Sandboxed execution with controlled bindings
- 🎯 **Simple** - Just wrap your existing Vercel AI SDK calls

## Generated Code Example

```chromesidekick
// LLM should output ONLY this fenced block when using code mode
const location = await getUserLocation();
const weather = await getWeather({ location });
return weather;
```

If a model cannot adhere to `chromesidekick` fencing, `code-mode` falls back to detecting ```javascript or ```js fenced blocks.

## Requirements

- Node.js 18+
- Vercel AI SDK (`ai` package)
- Tools using `tool()` helper with `execute` functions

Works with both TypeScript and JavaScript.

## License

MIT