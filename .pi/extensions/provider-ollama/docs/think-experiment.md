# Thinking Effort Experiment

Tests how different `reasoning_effort` values affect thinking output on Ollama Cloud models.
Based on [ollama/ollama#15952](https://github.com/ollama/ollama/issues/15952).

Reads models from `~/.pi/agent/cache/ollama-cloud-models.json` and API key from `~/.pi/agent/auth.json` (`ollama-cloud` key).

## OpenAI-compatible endpoint (`/v1/chat/completions`)

This is what pi-ollama-cloud uses.

```bash
#!/usr/bin/env bash
set -euo pipefail

RUNS="${1:-5}"
OUTFILE="${2:-/tmp/think-openai.jsonl}"
CACHE="${HOME}/.pi/agent/cache/ollama-cloud-models.json"
AUTH="${HOME}/.pi/agent/auth.json"
PROMPT="What is 7 * 8?"

TOKEN=$(jq -r '.["ollama-cloud"].key // empty' "$AUTH")
if [ -z "$TOKEN" ]; then echo "ERROR: no ollama-cloud key in $AUTH" >&2; exit 1; fi

MODELS=$(jq -r '.models | to_entries[] | select(.value.capabilities | index("thinking")) | .key' "$CACHE")
echo "Models: $(echo "$MODELS" | wc -l), runs: $RUNS, output: $OUTFILE" >&2

for model in $MODELS; do
  for effort in none low medium high max; do
    echo "  $model $effort" >&2
    for ((i=1; i<=RUNS; i++)); do
      curl -s https://ollama.com/v1/chat/completions \
        -H "Authorization: Bearer $TOKEN" \
        -H "Content-Type: application/json" \
        -d "$(jq -nc --arg model "$model" --arg prompt "$PROMPT" --arg effort "$effort" '{
          model: $model, messages: [{role: "user", content: $prompt}],
          reasoning_effort: $effort, stream: false
        }')" | jq -c --arg model "$model" --arg effort "$effort" --arg run "$i" \
          '{model: $model, effort: $effort, run: $run, response: .}' >> "$OUTFILE" || \
        echo "    FAIL: $model $effort run $i" >&2
    done
  done
done
echo "Done: $OUTFILE" >&2
```

## Analysis

### Markdown tables

```bash
# OpenAI-compatible endpoint
echo "| Model | none | low | medium | high | max |"
echo "|-------|------|-----|--------|------|-----|"
jq -r '[.model, .effort, (.response.choices[0].message.reasoning // "" | length)] | @tsv' /tmp/think-openai.jsonl |
  awk '{
    k=$1" "$2; sum[k]+=$3; sumsq[k]+=$3*$3; count[k]++
  }
  END {
    for (k in sum) {
      split(k, a, " "); m=sum[k]/count[k]; s=sqrt(sumsq[k]/count[k]-m*m)
      d[a[1]][a[2]] = sprintf("%.0f ± %.0f", m, s)
    }
    for (m in d) printf "| %-45s | %12s | %12s | %12s | %12s | %12s |\n", m,
      d[m]["none"], d[m]["low"], d[m]["medium"], d[m]["high"], d[m]["max"]
  }' | sort
```

### Quick checks

```bash
# Models where "none" still returns reasoning
jq -r 'select(.effort == "none" and (.response.choices[0].message.reasoning // "" | length) > 2) | .model' /tmp/think-openai.jsonl | sort -u
```

## Results

| Model | none | low | medium | high | max |
|-------|------|-----|--------|------|-----|
| cogito-2.1:671b                               |        0 ± 0 |    384 ± 138 |    308 ± 162 |    601 ± 305 |    398 ± 249 |
| deepseek-v3.1:671b                            |        0 ± 0 |     459 ± 44 |     594 ± 85 |     560 ± 40 |     512 ± 68 |
| deepseek-v3.2                                 |        0 ± 0 |    195 ± 155 |    229 ± 163 |     119 ± 10 |     140 ± 55 |
| deepseek-v4-flash                             |        0 ± 0 |      93 ± 13 |     104 ± 21 |      92 ± 13 |    454 ± 149 |
| deepseek-v4-pro                               |        0 ± 0 |      100 ± 8 |     112 ± 14 |     127 ± 11 |      120 ± 6 |
| gemini-3-flash-preview                        |        0 ± 0 |     72 ± 144 |        0 ± 0 |        0 ± 0 |        0 ± 0 |
| gemma4:31b                                    |        0 ± 0 |      84 ± 11 |       88 ± 5 |      95 ± 17 |      87 ± 10 |
| glm-4.6                                       |        0 ± 0 |   3829 ± 996 |   3012 ± 354 |  4064 ± 1679 |   3127 ± 899 |
| glm-4.7                                       |        0 ± 0 |    320 ± 102 |     187 ± 92 |    353 ± 181 |    259 ± 135 |
| glm-5                                         |        0 ± 0 |    244 ± 114 |    344 ± 146 |    319 ± 131 |     292 ± 87 |
| glm-5.1                                       |        0 ± 0 |     229 ± 50 |     220 ± 39 |     198 ± 17 |     231 ± 11 |
| gpt-oss:120b                                  |      65 ± 12 |       20 ± 8 |       68 ± 9 |     251 ± 78 |      99 ± 54 |
| gpt-oss:20b                                   |     115 ± 87 |       22 ± 5 |      91 ± 38 |    493 ± 296 |     160 ± 76 |
| kimi-k2.5                                     |        0 ± 0 |    310 ± 151 |    270 ± 121 |     314 ± 86 |    321 ± 185 |
| kimi-k2.6                                     |        0 ± 0 |     279 ± 63 |     238 ± 52 |    312 ± 102 |     207 ± 30 |
| kimi-k2-thinking                              |     131 ± 77 |     146 ± 16 |     204 ± 90 |     140 ± 21 |     167 ± 52 |
| minimax-m2.1                                  |    411 ± 470 |    261 ± 135 |     199 ± 62 |    261 ± 130 |     176 ± 61 |
| minimax-m2.5                                  |    275 ± 146 |    347 ± 226 |    264 ± 140 |    376 ± 199 |     175 ± 65 |
| minimax-m2.7                                  |    314 ± 138 |    314 ± 137 |    211 ± 123 |     231 ± 83 |    202 ± 118 |
| nemotron-3-nano:30b                           |        0 ± 0 |    981 ± 469 |    624 ± 713 |      76 ± 25 |    426 ± 449 |
| nemotron-3-super                              |        0 ± 0 |    799 ± 387 |    554 ± 416 |    380 ± 392 |      56 ± 19 |
| qwen3.5:397b                                  |        0 ± 0 |     379 ± 52 |     353 ± 60 |     369 ± 51 |     306 ± 20 |
| qwen3-next:80b                                |        0 ± 0 |   1224 ± 135 |   1378 ± 105 |    1365 ± 97 |   1306 ± 177 |
| qwen3-vl:235b                                 |    984 ± 274 |    908 ± 215 |    782 ± 197 |    942 ± 186 |   1042 ± 370 |

## Summary

Models where `"none"` **does not** disable thinking (used by `NO_OFF` map in `thinking-levels.ts`):

- `gpt-oss:20b`, `gpt-oss:120b` - documented: no off mode
- `kimi-k2-thinking` - only this specific kimi model; `kimi-k2.5`/`kimi-k2.6` work fine
- `minimax-m2.1`, `minimax-m2.5`, `minimax-m2.7` - entire minimax family affected
- `qwen3-vl:235b` - unlike other qwen3 models which support off

All other thinking-capable models correctly produce 0 thinking chars with `"none"`.

**Caveat on `max`:** The trivial `7 * 8` prompt used here is too simple to expose differences between `high` and `max` - most models terminate quickly regardless of effort. On harder prompts the gap can be substantial: e.g. `deepseek-v4-pro` burned ~32k tokens on `high` vs ~55k on `max` for a math puzzle (see [#11 review](https://github.com/fgrehm/pi-ollama-cloud/pull/11#discussion_r3193205703)). We still pass `xhigh` -> `max` through since it's a no-op when ignored and meaningful when it isn't.
