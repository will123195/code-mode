function createMockModel(responses) {
  let index = 0;

  function normalize(next) {
    if (typeof next !== 'object' || next == null) {
      throw new Error('Mock model requires object-shaped responses');
    }
    const toolScript = 'toolScript' in next ? String(next.toolScript) : undefined;
    const toolCalls = toolScript
      ? [{
          type: 'tool-call',
          toolCallType: 'function',
          toolCallId: `call_${index}`,
          toolName: 'runToolScript',
          args: JSON.stringify({ script: toolScript })
        }]
      : undefined;
    return {
      text: toolCalls ? undefined : (next.text ?? ''),
      toolCalls,
      finishReason: next.finishReason ?? 'stop',
      usage: next.usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    };
  }

  return {
    provider: 'mock',
    modelId: 'mock-1',
    supportsImageUrls: false,
    supportsUrl: false,
    async doGenerate(/* params */) {
      const next = index < responses.length ? responses[index++] : undefined;
      return normalize(next);
    },
    async doStream(/* params */) {
      return {
        stream: new ReadableStream({
          start(controller) {
            while (index < responses.length) {
              const norm = normalize(responses[index++]);
              if (norm.toolCalls) {
                for (const tc of norm.toolCalls) controller.enqueue({ type: 'tool-call', ...tc });
              } else if (norm.text) {
                controller.enqueue({ type: 'text-delta', textDelta: String(norm.text) });
              }
            }
            controller.enqueue({ type: 'finish', finishReason: 'stop', usage: { promptTokens: 0, completionTokens: 0 } });
            controller.close();
          }
        }),
        rawResponse: {},
        warnings: [],
        request: {}
      };
    },
  };
}

module.exports = { createMockModel };


