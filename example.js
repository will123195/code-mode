// Example usage with Vercel AI SDK
// Run: node example.js

const { codeMode } = require('./dist/index.js');

// Mock the Vercel AI SDK for this example
function mockStreamText(config) {
  console.log('🤖 AI System Prompt:', config.system.slice(0, 200) + '...\n');
  
  // Simulate what GPT would generate
  return Promise.resolve({
    text: `I'll help you check the weather at your location.

\`\`\`javascript
const location = await getUserLocation();
const weather = await getWeather({ location });
return {
  message: \`The weather in \${location} is \${weather.temperature}°F and \${weather.condition}\`,
  details: { location, weather }
};
\`\`\``,
  });
}

// Your tools (same as in README)
const tools = {
  getUserLocation: {
    description: 'Get user current location',
    inputSchema: {},
    execute: async () => 'San Francisco, CA',
  },
  
  getWeather: {
    description: 'Get weather for a location', 
    inputSchema: {},
    execute: async ({ location }) => ({
      location,
      temperature: 65,
      condition: 'foggy',
    }),
  },
};

async function example() {
  console.log('🚀 Code Mode Example\n');
  
  // Wrap the AI function with code mode
  const result = await codeMode(mockStreamText, {
    onCodeGenerated: (code) => {
      console.log('📝 Generated JavaScript:');
      console.log(code);
      console.log();
    },
    onCodeExecuted: (result) => {
      console.log('⚡ Code Execution Result:');
      console.log(JSON.stringify(result, null, 2));
      console.log();
    },
  })({
    model: 'openai/gpt-5',
    tools,
    messages: [
      { role: 'assistant', content: 'How can I help?' },
      { role: 'user', content: 'How is the weather?' },
    ],
  });
  
  console.log('✅ Final Response:');
  console.log('Code executed:', result.codeExecuted);
  console.log('Result:', result.executionResult);
}

example().catch(console.error);
