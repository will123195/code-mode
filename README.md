# code-mode

> **Transform Vercel AI SDK tools into JavaScript code execution**

[![npm version](https://badge.fury.io/js/code-mode.svg)](https://badge.fury.io/js/code-mode)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Inspired by [Cloudflare's Code Mode](https://blog.cloudflare.com/code-mode/)** - LLMs are better at writing JavaScript than using synthetic tool calling syntax.

## Installation

```bash
npm install ai code-mode
```

## Usage

```javascript
import { z } from 'zod';
import { streamText, tool } from 'ai';
import { codeMode } from 'code-mode';

const tools = {
  getUserLocation: tool({
    description: 'Get user current location',
    inputSchema: z.object({}),
    execute: async () => 'San Francisco, CA',
  }),
  getWeather: tool({
    description: 'Get weather for a location',
    inputSchema: z.object({
      location: z.string(),
    }),
    execute: async ({ location }) => {
      return { location, temperature: 65, condition: 'foggy' };
    },
  }),
};

// Just wrap your existing streamText call
const result = await codeMode(streamText)({
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

```javascript
// LLM generates code like this:
const location = await getUserLocation();
const weather = await getWeather({ location });
return weather;
```

## Requirements

- Node.js 18+
- Vercel AI SDK (`ai` package)
- Tools using `tool()` helper with `execute` functions

Works with both TypeScript and JavaScript.

## License

MIT