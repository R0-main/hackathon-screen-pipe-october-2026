# Evaluation data written by models

What `npm run eval` reads that a model wrote, versioned so a measurement can be run again and compared. Each file says
which prompt version and which model wrote it.

| File | What | Written by |
|---|---|---|
| `keywords.json` | Search keywords of the 94 current items of the demo and the corpus, by title. `npm run eval:seed` applies them. | `npm run keywords -- --cli --model haiku --export …`: one call per item, the item alone with its source (zone, author, app, date). Prompt `keywords-v1` (`packages/core/src/keywords.ts`), Haiku as at ingestion. |
| `keywords-sonnet.json` | The same, written by Sonnet, to compare. | Same prompt, `--model sonnet`. |
| `rephrasings.json` | For each of the 181 questions, the 2 phrasings an agent would send to `search_brain`. | `tsx scripts/eval-rephrase.ts --model sonnet`: one call per question, the question alone with the company's description, and the tool's own guidance (`PHRASINGS_GUIDANCE`, `packages/core/src/mcp.ts`). Prompt `rephrase-v2`. |
| `rephrasings-haiku.json` | The same, by Haiku: a lower bound, a small model as the agent. | `--model haiku`. |

In the product, the distillation writes the keywords with each item, seeing the session (the employee's own words);
the demo has no sessions, so the evaluation approximates them one item at a time, as the server's catch-up does.

A model never sees another item or another question, nor the expected answers: an earlier set of rephrasings, written
for all the questions at once, borrowed words from the other questions ("Valiere" became "Groupe Vallière") and
measured 84% found first instead of 76%. Change a prompt: bump its version, write the files again (`--all`), measure.

```bash
npm run seed && npm run eval:seed                                     # demo + corpus + keywords.json
EVAL_REPHRASINGS=scripts/eval-data/rephrasings.json npm run eval      # each question with the agent's phrasings
EVAL_ORIGINAL_WEIGHT=2 …                                              # the question as asked weighing 2 in the fusion
EVAL_KEYWORDS=off npm run eval:seed                                   # on a fresh demo: no keywords
```

## Measurements (October 27, 2026)

155 questions on the demo and the corpus (98 items, 4 of them superseded), 8 results per search. Found first, in the
first 3, MRR, and the questions trapped by the tempting wrong item (of 29 traps).

File storage:

| Configuration | First | Top 3 | MRR | Trapped |
|---|---|---|---|---|
| words only | 61% | 76% | 0.68 | 5 |
| + keywords (Haiku) | 66% | 85% | 0.76 | 4 |
| + keywords (Sonnet) | 68% | 86% | 0.77 | 3 |
| + phrasings (Sonnet), no keywords | 66% | 90% | 0.78 | 9 |
| + keywords + phrasings (Sonnet) | **76%** | **92%** | 0.84 | 5 |
| + keywords + phrasings, the question weighing 2 | 75% | 91% | 0.83 | 6 |
| + keywords + phrasings (Haiku as the agent) | 75% | 93% | 0.84 | 7 |
| voyage-4 | 74% | 95% | 0.84 | 3 |
| voyage-4 + keywords | 79% | 97% | 0.88 | 3 |
| voyage-4 + phrasings | 81% | 96% | 0.88 | 8 |
| voyage-4 + keywords + phrasings | **85%** | 96% | 0.91 | 4 |
| voyage-4 + keywords + phrasings (Haiku as the agent) | 83% | 97% | 0.90 | 6 |
| voyage-4 + keywords + phrasings + rerank-3 (once, with the question as asked) | **95%** | **99%** | 0.97 | 2 |

Postgres (keywords at weight D):

| Configuration | First | Top 3 | Trapped |
|---|---|---|---|
| words only | 61% | 77% | 6 |
| + keywords | 67% | 86% | 6 |
| + keywords + phrasings (Sonnet) | 75% | 92% | 7 |
| + keywords + phrasings (Haiku) | 77% | 93% | 8 |
| voyage-4 | 78% | 95% | 4 |
| voyage-4 + keywords | 79% | 95% | 4 |
| voyage-4 + phrasings | 83% | 95% | 5 |
| voyage-4 + keywords + phrasings | **86%** | 96% | 4 |

In every configuration: no access leak (16/16), no outdated version served. The keywords' weight barely matters on
file storage (0.25, 0.5, 1: 66%, 66%, 67% found first): they stay at 0.5, under the body (1). What they cost:
unanswerable questions almost always get a result now (0 of 8 come back empty, 1 before), and the graph has fewer empty
places to fill when the direct results are better (2 of 5 linked items found instead of 3).

With rerank-3, the relevance of a right first answer is never under 0.42 (148 questions, median 0.79), and the first
result of an unanswerable question never above 0.37 (8 questions): a threshold around 0.4 would answer "nothing found"
to all 8 without losing a right first answer. For comparison, voyage-4 + rerank-3 alone, one phrasing: 93% first, 97%
in the top 3.
