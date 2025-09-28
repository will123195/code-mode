const { toolScript } = require('../dist/index.js');
const { streamText, generateText, tool } = require('ai');
const { z } = require('zod');
const { createMockModel } = require('./mockModel');

// Tools defined like in README using ai.tool() and zod
const tools = {
  getUserLocation: tool({
    description: 'Get user current location',
    inputSchema: z.object({}),
    outputSchema: z.string(),
    execute: async () => 'San Francisco, CA',
  }),
  getWeather: tool({
    description: 'Get weather for a location',
    inputSchema: z.object({
      location: z.string(),
    }),
    outputSchema: z.object({ location: z.string(), temperature: z.number(), condition: z.string() }),
    execute: async ({ location }) => ({
      location,
      temperature: 65,
      condition: 'foggy',
    }),
  }),
};

async function test() {
  console.log('🧪 Testing tool-script...\n');
  
  try {
    const model = createMockModel([
      { toolScript: `const location = await getUserLocation();\nconst weather = await getWeather({ location });\nreturn { location, weather };` },
      { text: 'Done.' },
    ]);
    const result = await toolScript(generateText)({
      model,
      tools,
      system: 'You are a helpful assistant.',
      messages: [
        { role: 'user', content: 'What is the weather near me?' }
      ],
      maxSteps: 5,
      onFinish: ({ text, toolCalls, responseMessages }) => {
        console.log('🧾 onFinish text:', text);
      }
    });
    
    // If streaming, accumulate text for visibility
    if (result && result.textStream && result.textStream[Symbol.asyncIterator]) {
      let accumulated = '';
      for await (const delta of result.textStream) {
        accumulated += typeof delta === 'string' ? delta : (delta.textDelta || '');
      }
      console.log('\n🧵 Streamed text:', accumulated);
    }
    console.log('\n🎉 Final result:', result.text);
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
  }
}

test();
