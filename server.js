// server.js - OpenAI to OpenCode Zen API Proxy
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

// OpenCode Zen API configuration
// Zen = pay-per-use catalog. Se quiser usar a assinatura "Go" em vez de Zen,
// troca a base para: https://opencode.ai/zen/go/v1
const ZEN_API_BASE = process.env.ZEN_API_BASE || 'https://opencode.ai/zen/v1';
const ZEN_API_KEY = process.env.ZEN_API_KEY; // NUNCA hardcode aqui, sempre via env var

// 🔥 REASONING DISPLAY TOGGLE - Shows/hides reasoning in output
const SHOW_REASONING = true; // Set to true to show reasoning with <think> tags

// 🔥 THINKING MODE TOGGLE - Enables thinking for specific models that support it
const ENABLE_THINKING_MODE = false;

// Model mapping - traduz nomes "OpenAI-style" pro modelo real do OpenCode Zen
const MODEL_MAPPING = {
  'gpt-3.5-turbo': 'mimo-v2.5',
  'gpt-4': 'mimo-v2.5-pro',
  'gpt-4-turbo': 'deepseek-v4-flash-free',
  'gpt-4o': 'glm-5.2',
  'gpt-4o-mini': 'mimo-v2.5-free',
  'claude-3-opus': 'deepseek-v4-pro',
  'claude-3-sonnet': 'minimax-m2.7-free'
};

// Lê o corpo de erro que a Zen devolveu (pode vir como stream quando stream=true)
async function readUpstreamError(error) {
  const data = error.response?.data;
  if (!data) return null;
  if (typeof data.on === 'function') {
    return await new Promise((resolve) => {
      let body = '';
      data.on('data', (c) => { body += c.toString(); });
      data.on('end', () => resolve(body));
      data.on('error', () => resolve(body));
    });
  }
  return typeof data === 'string' ? data : JSON.stringify(data);
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'OpenAI to OpenCode Zen Proxy',
    reasoning_display: SHOW_REASONING,
    thinking_mode: ENABLE_THINKING_MODE
  });
});

// List models endpoint (OpenAI compatible) - com e sem prefixo /v1
app.get(['/v1/models', '/models'], (req, res) => {
  const models = Object.keys(MODEL_MAPPING).map(model => ({
    id: model,
    object: 'model',
    created: Date.now(),
    owned_by: 'opencode-zen-proxy'
  }));

  res.json({
    object: 'list',
    data: models
  });
});

// Chat completions endpoint (main proxy)
async function handleChatCompletions(req, res) {
  const { model, messages, temperature, max_tokens, stream } = req.body;
  let zenModel;

  try {
    // Smart model selection with fallback
    zenModel = MODEL_MAPPING[model];
    if (!zenModel) {
      // Se o model pedido já for um nome válido de modelo Zen, usa direto
      zenModel = model;
    }

    // Transform OpenAI request to Zen format
    const zenRequest = {
      model: zenModel,
      messages: messages,
      temperature: temperature || 0.8,
      max_tokens: max_tokens || 32768,
      extra_body: ENABLE_THINKING_MODE ? { chat_template_kwargs: { thinking: true } } : undefined,
      stream: stream || false
    };

    // Make request to OpenCode Zen API
    const response = await axios.post(`${ZEN_API_BASE}/chat/completions`, zenRequest, {
      headers: {
        'Authorization': `Bearer ${ZEN_API_KEY}`,
        'Content-Type': 'application/json'
      },
      responseType: stream ? 'stream' : 'json'
    });

    if (stream) {
      // Handle streaming response with reasoning
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      let buffer = '';
      let reasoningStarted = false;

      response.data.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        lines.forEach(line => {
          if (line.startsWith('data: ')) {
            if (line.includes('[DONE]')) {
              res.write(line + '\n');
              return;
            }

            try {
              const data = JSON.parse(line.slice(6));
              if (data.choices?.[0]?.delta) {
                const reasoning = data.choices[0].delta.reasoning_content;
                const content = data.choices[0].delta.content;

                if (SHOW_REASONING) {
                  let combinedContent = '';

                  if (reasoning && !reasoningStarted) {
                    combinedContent = '<think>\n' + reasoning;
                    reasoningStarted = true;
                  } else if (reasoning) {
                    combinedContent = reasoning;
                  }

                  if (content && reasoningStarted) {
                    combinedContent += '</think>\n\n' + content;
                    reasoningStarted = false;
                  } else if (content) {
                    combinedContent += content;
                  }

                  if (combinedContent) {
                    data.choices[0].delta.content = combinedContent;
                    delete data.choices[0].delta.reasoning_content;
                  }
                } else {
                  if (content) {
                    data.choices[0].delta.content = content;
                  } else {
                    data.choices[0].delta.content = '';
                  }
                  delete data.choices[0].delta.reasoning_content;
                }
              }
              res.write(`data: ${JSON.stringify(data)}\n\n`);
            } catch (e) {
              res.write(line + '\n');
            }
          }
        });
      });

      response.data.on('end', () => res.end());
      response.data.on('error', (err) => {
        console.error('Stream error:', err);
        res.end();
      });
    } else {
      // Transform Zen response to OpenAI format with reasoning
      const openaiResponse = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: response.data.choices.map(choice => {
          let fullContent = choice.message?.content || '';

          if (SHOW_REASONING && choice.message?.reasoning_content) {
            fullContent = '<think>\n' + choice.message.reasoning_content + '\n</think>\n\n' + fullContent;
          }

          return {
            index: choice.index,
            message: {
              role: choice.message.role,
              content: fullContent
            },
            finish_reason: choice.finish_reason
          };
        }),
        usage: response.data.usage || {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0
        }
      };

      res.json(openaiResponse);
    }

  } catch (error) {
    const upstreamBody = await readUpstreamError(error);
    const status = error.response?.status || 500;

    // Log completo pro painel do Render (ajuda a achar a causa real)
    console.error('Proxy error:', error.message);
    console.error('  upstream status:', status);
    console.error('  upstream body:', upstreamBody || '(vazio)');
    console.error('  request:', JSON.stringify({
      model_requested: model,
      model_sent: zenModel,
      messages: Array.isArray(messages) ? messages.length : typeof messages,
      max_tokens: max_tokens,
      temperature: temperature,
      stream: !!stream
    }));

    // Devolve o erro real da Zen pro cliente (JanitorAI/Lorebary)
    res.status(status).json({
      error: {
        message: upstreamBody ? `${error.message} | Zen: ${upstreamBody}` : (error.message || 'Internal server error'),
        type: 'invalid_request_error',
        code: status
      }
    });
  }
}

// Registrada com e sem /v1, funciona seja qual for a base URL do cliente
app.post(['/v1/chat/completions', '/chat/completions'], handleChatCompletions);

// Catch-all for unsupported endpoints
app.all('*', (req, res) => {
  res.status(404).json({
    error: {
      message: `Endpoint ${req.path} not found`,
      type: 'invalid_request_error',
      code: 404
    }
  });
});

app.listen(PORT, () => {
  console.log(`OpenAI to OpenCode Zen Proxy running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Reasoning display: ${SHOW_REASONING ? 'ENABLED' : 'DISABLED'}`);
  console.log(`Thinking mode: ${ENABLE_THINKING_MODE ? 'ENABLED' : 'DISABLED'}`);
});
