# Review routing eval

Model: claude-haiku-5-5. Prompt hash: d53733f4b650a839. Cases: 50.

Result: PASS, 0 delicate review(s) would have been posted (target: 0).

| | Recall on delicate | Precision | Misses | False holds |
|---|---|---|---|---|
| What reaches the owner (classifier, tripwire, stars) | 100.0% | 96.8% | 0 | 1 |
| Cases only the classifier decides (20 delicate: rating 3+, no tripwire hit) | 100.0% | 95.2% | 0 | 1 |
| Classifier alone | 100.0% | 96.8% | 0 | 1 |

Classifier errors (each sent to the owner): 0.

## By language

| Language | Cases | Delicate | Recall | Precision | Misses | False holds | Errors |
|---|---|---|---|---|---|---|---|
| en | 20 | 14 | 100.0% | 100.0% | 0 | 0 | 0 |
| de | 10 | 5 | 100.0% | 83.3% | 0 | 1 | 0 |
| tr | 10 | 5 | 100.0% | 100.0% | 0 | 0 | 0 |
| es | 10 | 6 | 100.0% | 100.0% | 0 | 0 | 0 |

## Misses

None.

## False holds

- de-10 (4 stars): "Ganz okay, Kaffee solide.". classifier: delicate (other); route: delicate

## Cost

39689 input and 1535 output tokens, about $0.0047.
