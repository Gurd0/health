# What data comes from where

The database is filled from three origins (the `origin` column):

| origin | how | covers |
|---|---|---|
| `api` | `ingest sync` / the server's daily sync (Google Health API v4) | everything in [Synced from the API](#synced-from-the-api), from the last stored row onwards |
| `takeout` | `ingest takeout` on a Google Takeout export, `Google Health/` folder | Pixel Watch / Fitbit data, including what the API doesn't offer |
| `fit-legacy` | `ingest takeout`, `Fit/` folder | old Google Fit phone data, 2019 onwards; frozen, nothing new arrives |

When the same row exists in more than one origin, `api` wins over `takeout`, which wins over
`fit-legacy` (see "Syncing from the Google Health API" in the README for the merge rules).

**What you enter yourself** (training plans, run notes and effort, shoes, weekly targets) is kept
apart in `data/training.duckdb`. It can't be rebuilt from `raw/` like the rest, so back it up
together with `data/health.duckdb`. See "Training" in the README.

**In short:** the daily sync keeps heart rate, activity, sleep stages, daily vitals and workouts up
to date. Running form, cardio load, readiness, sleep scores, stress/EDA and temperature only come
from a takeout, so those parts of the dashboard stop at the date of your latest takeout until you
import a new one.

## Synced from the API

Data types requested by `ingest/sync.py` (`ALL_TYPES`). Names are the API's and are used as
`data_type` in the database.

| kind | data types | table |
|---|---|---|
| samples | `heart-rate`, `heart-rate-variability`, `oxygen-saturation`, `respiratory-rate-sleep-summary`, `vo2-max`, `run-vo2-max`, `weight`, `height`, `body-fat` | `observations` |
| intervals | `steps`, `distance`, `altitude`, `active-energy-burned`, `active-minutes`, `active-zone-minutes`, `activity-level`, `time-in-heart-rate-zone`, `sedentary-period`, `swim-lengths-data` | `observations` |
| daily | `daily-resting-heart-rate`, `daily-heart-rate-variability`, `daily-oxygen-saturation`, `daily-respiratory-rate`, `daily-sleep-temperature-derivations`, `daily-vo2-max`, `daily-heart-rate-zones` | `daily` |
| sessions | `sleep` (sessions + stages), `exercise` (workouts, with the API's per-km splits and summary metrics) | `sleep_sessions`, `sleep_stages`, `workouts` |
| run tracks | `exercise-tcx`: the `exportExerciseTcx` file of each watch run: per-second GPS, distance, altitude and heart rate | `workout_trackpoints` |

Gaps compared with the takeout version of the same data:
- **Sleep:** the API has sessions and stages but **no sleep scores** (overall, duration,
  composition, revitalization), REM %, sleeping heart rate or restlessness. Those are kept from the
  takeout when the session ids match; sleeps newer than the last takeout have none.
- **Exercise:** no log type (auto-detected vs manual) and no peak heart rate in the summary. Kept
  from the takeout where present.
- **SpO2:** the API filters out some readings that the takeout includes. Takeout rows the API
  doesn't return are kept.

## Only in a takeout

Imported by `ingest takeout`, but there's no matching type in the API sync, so these only
change when you import a new export.

| data type | what it is | used by the dashboard |
|---|---|---|
| `cadence`, `stride-length`, `ground-contact-time`, `vertical-oscillation`, `vertical-ratio` | running form during runs | Run detail: running-form charts (newer runs show only the API's average cadence) |
| `speed`, `live-pace` | speed and pace during workouts | Run detail: pace chart (falls back to the TCX distance stream) |
| `cardio-load`, `cardio-load-observed-interval` | training load | Overview load-and-recovery table, Run detail context |
| `cardio-acute-chronic-workload-ratio` | acute:chronic workload ratio and its label | Run detail context |
| `daily-readiness` | readiness score and level | — |
| sleep scores (columns in `sleep_sessions`) | overall/duration/composition/revitalization score, REM %, restlessness | Overview sleep score |
| `gps-location` | all GPS samples, not only runs | fallback route for runs without a TCX track |
| `body-temperature`, `body-temperature-2` | skin and body temperature series | — |
| `continuous-eda`, `body-response-event`, `body-response-algorithm-features` | EDA / stress (body response) | — |
| `breathing-quality`, `daily-sleep-breathing-quality`, `breathing-quality-assessment` | breathing during sleep | — |
| `micro-motion`, `micro-stillness` | movement and stillness during sleep/rest | — |
| `calories` | total calories (the API sync only has `active-energy-burned`) | — |
| `calories-in-heart-rate-zone`, `floors` | exist in the API only as rollups, not synced yet | — |
| `moods`, `blood-pressure-assessment`, `daily-insulin-resistance` | occasional manual or assessment entries | — |

## Only in legacy Google Fit (`fit-legacy`)

From the takeout's `Fit/` folder. Google Fit is no longer updated, so this is history only.

| data type | what it is |
|---|---|
| `daily-steps`, `daily-distance`, `daily-calories`, `daily-active-minutes`, `daily-heart-points`, `daily-heart-minutes`, `daily-weight` | daily summary CSV |
| `daily-walking-duration`, `daily-running-duration`, `daily-biking-duration`, `daily-inactive-duration` | time per activity per day |
| `steps`, `distance`, `calories`, `active-minutes`, `heart-minutes`, `speed`, `weight`, `height`, `basal-metabolic-rate`, `gps-location`, `activity-segment` | merged Fit streams |
| workouts and their TCX files | sessions with distance, time, calories, steps (no heart rate or running form) |

## In the takeout but not imported

Left in `raw/` and not read by the importers: `Global Export Data/` (Fitbit-format duplicates of
the above), the top-level `Temperature/`, `Heart Rate Variability/`, `Oxygen Saturation (SpO2)/`,
`Stress Journal/` and `Biometrics/` folders, `UserActivityProbabilities`, and account and settings
files.

## Keeping takeout-only data current

Request a Google Takeout (Google Health, and Fit if you want) every now and then, unzip it to
`raw/takeout-YYYY-MM-DD/` and import it. On the server:

```
docker compose stop
docker compose run --rm health python -m ingest takeout raw/takeout-YYYY-MM-DD
docker compose start
```

Overlapping exports are safe: rows merge on their natural key and API rows take precedence.
