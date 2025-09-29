# tool-scripting

Plug-n-play "code mode" tool call scripting for Vercel AI SDK

[![npm version](https://badge.fury.io/js/code-mode.svg)](https://badge.fury.io/js/tool-scripting)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Inspired by [Cloudflare's Code Mode](https://blog.cloudflare.com/code-mode/)** - LLMs are better at writing JavaScript than using synthetic tool calling syntax.

## Installation

```bash
npm install ai tool-scripting
```

## Usage

```javascript
import { z } from 'zod';
import { generateText, tool, stepCountIs } from 'ai';
import { openai } = from '@ai-sdk/openai';
import { toolScripting } from 'tool-scripting';

const tools = {
  getUserLocation: tool({
    description: 'Get user current location',
    inputSchema: z.object({}),
    outputSchema: z.string(), // optional outputSchema to help the LLM compose tool calls
    execute: async () => 'San Francisco, CA',
  }),
  getWeather: tool({
    description: 'Get weather for a location',
    inputSchema: z.object({
      location: z.string(),
    }),
    outputSchema: z.object({ // optional outputSchema to help the LLM compose tool calls
      temperature: z.number(),
      condition: z.string(),
    }),
    execute: async ({ location }) => {
      return { location, temperature: 65, condition: 'foggy' };
    },
  }),
};

// Just wrap your existing generateText (or streamText)
const betterGenerateText = toolScripting(generateText)

// Same familiar AI SDK usage
const result = await betterGenerateText({
  model: openai('gpt-5'),
  tools,
  messages: [
    { role: 'assistant', content: 'How can I help?' },
    { role: 'user', content: 'Check the weather near me' },
  ],
  stopWhen: stepCountIs(5),
});
```

## How it works

1. **Converts** your tool definitions to a tool call SDK
2. **LLM Generates** JavaScript code instead of tool calls
3. **Executes** code in secure sandbox (v8 isolate) with tool bindings
4. **Returns** whatever the generated code returns

## Why Code Mode?

**Tool Scripting > Tool Calls**

- 🧠 **Better** - LLMs excel at JavaScript vs synthetic tool syntax
- 🔧 **Composable** - Logic and conditionals between tool calls
- 🔒 **Secure** - Sandboxed execution with controlled bindings
- 🎯 **Simple** - Just wrap your existing Vercel AI SDK calls

## Example

Here's what a traditional series of tool calls looks like (without Tool Scripting):

```
role: user
text: Check the weather near me
--
role: assistant
type: tool-call
toolName: getUserLocation
--
role: tool
type: tool-result
output: San Francisco, CA
--
role: assistant
type: tool-call
toolName: getWeather
input:
  location: San Francisco, CA
--
role: tool
type: tool-result
output:
  temperature: 65
  condition: foggy
--
role: assistant
text: The weather in San Francisco, CA today is foggy with a temperature of 65°F.
```

Now, here's the same process with Tool Scripting:

```
role: user
text: Check the weather near me
--
role: assistant
type: tool-call
toolName: runToolScript
input:
  script: const location = await getUserLocation();\nconst weather = await getWeather({ location });\nreturn { location, weather };
--
role: tool
type: tool-result
output:
  location: San Francisco, CA
  weather:
    temperature: 65
    condition: foggy
--
role: assistant
text: The weather in San Francisco, CA today is foggy with a temperature of 65°F.
```

💥 In a single LLM step, we composed two tools to get the user's location and then the weather for that location.

## Requirements

- Node.js 18+
- Vercel AI SDK (`ai` package)
- Tools using `tool()` helper with `execute` functions

Works with both TypeScript and JavaScript.

## License

MIT