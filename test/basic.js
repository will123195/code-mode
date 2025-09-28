const { codeMode } = require('../dist/index.js');

// Mock AI function for testing
async function mockGenerateText(config) {
  console.log('Mock AI called with:', {
    system: config.system.slice(0, 100) + '...',
    tools: Object.keys(config.tools || {}),
  });
  
  // Simulate LLM generating code
  return {
    text: `I'll get your location and check the weather.

\`\`\`javascript
const location = await getUserLocation();
const weather = await getWeather({ location });
return { location, weather };
\`\`\``,
  };
}

// Mock tools
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

async function test() {
  console.log('🧪 Testing code-mode...\n');
  
  try {
    const wrappedFunction = codeMode(mockGenerateText, {
      onCodeGenerated: (code) => console.log('📝 Generated code:\n', code),
      onCodeExecuted: (result) => console.log('✅ Execution result:', result),
      onError: (error) => console.log('❌ Execution error:', error.message),
    });
    
    const result = await wrappedFunction({
      tools,
      messages: [
        { role: 'user', content: 'How is the weather?' }
      ],
    });
    
    console.log('\n🎉 Final result:', JSON.stringify(result, null, 2));
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
  }
}

test();
