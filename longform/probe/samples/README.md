# Rendered samples — one per visual type

Committed here rather than under `auto-poster/samples/`, which `.gitignore`
excludes as regenerable carousel output. These are review evidence for the
illustrated-B-roll PR: without them in the tree, a PR that says "samples
included" contains no samples, which is exactly what happened the first time.

Regenerate with the probe rather than by hand:

```
node longform/probe/probe-visual-intents.mjs   # needs ANTHROPIC_API_KEY
```

| file | type | topic |
| --- | --- | --- |
| `01-number_breakdown-taxes.png` | NUMBER_BREAKDOWN | property taxes |
| `02-timeline-taxes.png` | TIMELINE | property taxes |
| `03-callout-taxes.png` | CALLOUT | property taxes |
| `04-comparison-taxes.png` | COMPARISON | property taxes |
| `05-list-taxes.png` | LIST | property taxes |
| `06-map-schools.png` | MAP | school districts |

Every one passed the same QC the pipeline applies before a visual reaches the
timeline: downscaled to 1080p, checked for blankness, ink coverage inside the
measured range, and no ink in the safe margin. Map geometry is Census
TIGER/Line, public domain — see [MAP-LICENSING.md](../MAP-LICENSING.md).
