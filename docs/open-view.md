# Watching the ward without a token

A viewer build (`VITE_VIEW_API_URL` set) with no token asks `GET {VIEW_API}/wards/W4/open-view` first; while the answer stays valid it asks again 2 s after each answer. Wire contract: `contract-open-view` v1.1. Code: `src/open-view.ts`.

## What the page does

- A valid body: the page draws the ward read-only, shows "Watching, read-only" and a "Sign in to control" button, and asks again 2 s after each answer or failure.
- Anything else on the first request (404, other status, 5xx, network error, timeout, bad body): today's sign-in form.
- While watching: a 5xx, network error or timeout keeps the last picture and shows "Not updating". A redirect (301, 302, 303, 307, 308) is refused and counts as a network error: "Not updating", and polling goes on. Any other status from 201 to 499, or a bad or over-cap body, ends the watch and shows sign-in. There is no retry until a reload.
- "Sign in to control" leaves watching and shows sign-in. After a sign-in the page works as before and never calls the open route. A 401 from `/live` or from a command tries the open route once more. A signed-in viewer has a "Sign out" button in the top bar: it drops the token and asks the open route once, so the page returns to watching if the route answers and to the sign-in form if not.
- A bed is tagged only when both rank and risk are set. It is grey when risk is null. So a not-ranked bed shows no NR tag. The side panel has no "Not ranked (NR)" line. Figures are coloured by role only.
- With a token present, no open-view request is made at all. A build without `VITE_VIEW_API_URL` is unchanged.

## The whole hospital, when the server runs one

Code: `src/open-hospital.ts` (pure) and `src/open-panels.tsx`. Tests: `src/open-hospital.test.tsx`.

- While watching, the page also asks the same open route for the other units (`ER`, `ICU`, `MED3A`, `MED3B`, `SURG5A`), one unit at a time in turn. The unit list is the runner's own (`RUN_UNITS`): the API has no public list of units yet.
- If any of them answers, the server runs a whole hospital. The page then draws the building: building, floor, bed. The side panel has a breadcrumb ("Hospital › 3F Medicine 3A › Bed ..."), Escape goes up one level, and the top bar says "Hospital" and "Server clock". The two-way switch is not shown then.
- If none answers (404: the server runs ward W4 alone), the page is the ward, exactly as described above. A unit that answered 404 is asked again once a minute, so the page follows the server without a reload.
- What is real: which beds are in use in each unit, and each bed's NEWS2 band and rank where the unit is ranked. The ER's beds are grey (shown, not ranked) and intensive care's carry no NEWS2 colour at all.
- What is not from the server: where a bed is drawn inside its unit. The open answer has no positions, so beds fill the unit's drawn beds in the list's order, ranked first. Figures outside W4 have one neutral look and no name, age, group or triage. Nurses outside W4, the ER queue and the morgue are not drawn.
- A click selects a floor or a bed in use, nothing else. A bed's card shows the band, the rank and the unit, and "Sign in to see this patient's vitals".
- Pace (rule 8): no route is asked more often than every 2 s. W4 is asked every 2 s as before. Each other unit is asked once when the page opens (200 ms apart, so the building fills in about a second), then one of them every 2 s in turn, which is each of them every 10 s.
- Rule 6 for these units: a bed label that passed the label pattern is shown as a text node in the list and the card. It is never used as HTML, a URL, a selector or a style.

## The link to the hospital

In a viewer build the top bar has a two-way switch: "Live ward W4 (server)" and "Whole hospital (demo in your browser)", with a clock label for each. The second goes to `{BASE_URL}hospital/`. That page is the standalone hospital build (no API address, no key), uploaded by the deploy job beside the ward page. It runs in the visitor's browser and is labelled "Simulated in your browser, not the server's ward W4". It reads nothing from the API. Served under `/hospital/` it has the same switch, so the way back is the first button. Tests: `src/public-hospital.test.ts`.

## The nine rules (wire contract, section 9.1), and where they are tested

1. No credential to the open route: `credentials: "omit"`, no `headers` key at all (a simple GET), `redirect: "error"`.
2. No name or title for a figure: staff are named only "Nurse", "Charge nurse", "Physician".
3. Nothing is stored: no browser storage and no cookie. `cache: "no-store"`. Checked by a source scan of `src/open-view.ts` and `src/App.tsx` only.
4. No control without a token: the top bar has no speed button or Reset (the speed shows as text, read-only), the side panel has no control button (its only buttons are the bed rows, which select a bed on this page and send nothing), and `/live` is not read.
5. No other API call without a token.
6. No string from the answer reaches markup. Bed labels must match `[A-Za-z0-9][A-Za-z0-9 ._-]{0,19}`. W4's are only matched against the map's `BEDS`; another unit's are shown as text nodes only (see "The whole hospital").
7. Unknown keys are ignored and never read.
8. Poll every 2 s, not faster: the next request is scheduled 2 s after the last answer or failure, one at a time.
9. No logging of the answer.

Tests are in `src/open-view.test.ts` and `src/open-view.draw.test.ts`. The guards inside `src/App.tsx` (rules 4 and 5, click, hover, select list) are checked by scans of its source, not by mounting the page.

## Limits of the body

At most 64 KiB, read with a byte count, and a 5 s timeout. `clockS` at most 1e9. At most 100 beds, 20 staff and 20 moves. `ward` must equal `W4`. Any field out of shape, any unknown enum value, any number not finite or out of range refuses the whole body.

## Limits

- Synthetic data only. The route serves a synthetic run only.
- The API route may not exist yet, or may be off. Then the page is as before: the sign-in form.
