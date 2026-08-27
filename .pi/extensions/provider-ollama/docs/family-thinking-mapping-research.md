# Family thinking-level mapping research

Research date: 2026-07-21

## Mapping policy

The extension deliberately uses one map per model family. It does not preserve controls for older generations or individual variants. Each family inherits the mapping selected from its newest audited generation, even when an older model supports a different set of controls.

Ollama's OpenAI adapter accepts `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `ultra`, and `max`. It converts `none` to thinking off, `minimal` to `low`, and `xhigh`/`ultra` to `max`, then supplies `enable_thinking` and `reasoning_effort` to the model template.

Sources:

- [Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility)
- [Ollama thinking capability](https://docs.ollama.com/capabilities/thinking)
- [Ollama OpenAI effort conversion](https://github.com/ollama/ollama/blob/d366f4868ab08fda9cfc92cb588b651401202906/openai/openai.go#L523-L547)
- [Ollama template arguments](https://github.com/ollama/ollama/blob/d366f4868ab08fda9cfc92cb588b651401202906/llm/llama_server.go#L2190-L2201)

## Selected family mappings

### Qwen

Representative generation: Qwen 3.8.

Ollama's Qwen 3.8 renderer recognizes Low, Medium, and Extra High behavior and supports thinking off. The renderer maps its internal High and Max values to Qwen's Extra High instructions.

Family map:

- `off -> none`
- `low -> low`
- `medium -> medium`
- `xhigh -> xhigh`

This map also applies to Qwen 3.5, Qwen 3.6, Flash, Max, and parameter-size variants.

Sources:

- [Ollama Qwen 3.8 effort resolver](https://github.com/ollama/ollama/blob/d366f4868ab08fda9cfc92cb588b651401202906/model/renderers/qwen35.go#L113-L134)
- [Ollama Qwen 3.8 renderer tests](https://github.com/ollama/ollama/blob/d366f4868ab08fda9cfc92cb588b651401202906/model/renderers/qwen38_test.go#L372-L397)
- [Ollama Qwen 3.8 reference template](https://github.com/ollama/ollama/blob/d366f4868ab08fda9cfc92cb588b651401202906/model/renderers/testdata/qwen38_chat_template.jinja#L46-L56)

### DeepSeek

Representative generation: DeepSeek V4.

DeepSeek's official API accepts Low, High, and Max for both V4 Flash and V4 Pro. It maps Medium and Extra High to High. The current Flash and Pro aliases route to Flash 0731 and Pro 0813.

Family map:

- `off -> none`
- `low -> low`
- `high -> high`
- `max -> max`

This map also applies to older DeepSeek models.

Sources:

- [DeepSeek thinking-mode guide](https://api-docs.deepseek.com/guides/thinking_mode)
- [DeepSeek Chat Completions schema](https://api-docs.deepseek.com/api/create-chat-completion)
- [DeepSeek API landing page](https://api-docs.deepseek.com/)
- [DeepSeek V4 Pro release](https://api-docs.deepseek.com/news/news260813)

### GLM

Representative generation: GLM 5.3.

Z.ai documents GLM 5.3 and GLM 5.3 Flash as forced-thinking models with Low, High, and Max effort. Older GLM models may support off or fewer levels, but the family map follows 5.3.

Family map:

- No off mode
- `low -> low`
- `high -> high`
- `max -> max`

Sources:

- [Z.ai Chat Completion API](https://docs.z.ai/api-reference/llm/chat-completion)
- [Z.ai thinking mode](https://docs.z.ai/guides/capabilities/thinking-mode)
- [Ollama GLM 5.3 Flash model page](https://ollama.com/library/glm-5.3-flash)

### Kimi

Representative generation: Kimi K3.

No usable first-party Kimi K3 effort enum or off control was found in the audited Moonshot and Alibaba documentation. Ollama marks Kimi K3 as thinking-capable but does not list graded effort controls. The family therefore exposes only enabled/default thinking rather than borrowing K2 controls or guessing K3 levels.

Family map:

- Only `high -> high`
- Off and graded levels are hidden

The High label means enabled/default thinking. It does not assert a native Kimi High tier. This map also applies to Kimi K2.6 and K2.7 Code.

Sources:

- [Alibaba Model Studio deep thinking](https://www.alibabacloud.com/help/en/model-studio/deep-thinking)
- [Alibaba Model Studio model list](https://www.alibabacloud.com/help/en/model-studio/models)
- [Ollama Kimi K3 model page](https://ollama.com/library/kimi-k3)

### Nemotron

Representative generation: Nemotron 3 Ultra.

NVIDIA documents thinking off, full/default thinking, and a `medium_effort` mode for Ultra. Nano and Super differ, but the family map follows Ultra.

Family map:

- `off -> none`
- `medium -> medium`
- `high -> high`

NVIDIA's native control is a template flag rather than an OpenAI effort enum. This family mapping assumes Ollama Cloud translates its Medium effort to the corresponding Ultra behavior.

Sources:

- [NVIDIA Nemotron 3 Ultra model card](https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-BF16)
- [Ollama Nemotron 3 Ultra model page](https://ollama.com/library/nemotron-3-ultra)

### Muse

Representative generation: Muse Spark 1.2.

Meta documents Minimal, Low, Medium, High, and Extra High for Muse Spark and says Spark rejects `none`. Muse Glimmer has a smaller level set, but the family map follows the newer Spark controls.

Family map:

- No off mode
- `minimal -> minimal`
- `low -> low`
- `medium -> medium`
- `high -> high`
- `xhigh -> xhigh`

Sources:

- [Meta reasoning documentation](https://dev.meta.ai/docs/reasoning)
- [Meta model list](https://dev.meta.ai/docs/models)
- [Meta Muse Glimmer model page](https://developer.meta.com/ai/models/muse-glimmer/)

## Maintenance rule

Add or update one family entry only when a newer generation has been audited. Do not add model IDs, version checks, size checks, or variant checks to `thinking-levels.ts`. When a newer generation changes controls, replace the whole family's map and update every family member together.
