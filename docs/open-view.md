# Watching the ward without a token

A viewer build (`VITE_VIEW_API_URL` set) with no token asks `GET {VIEW_API}/wards/W4/open-view` once. Wire contract: `contract-open-view` v1.1. Code: `src/open-view.ts`.

## What the page does

- A valid body: the page draws the ward read-only, shows "Watching, read-only" and a "Sign in to control" button, and polls every 2 s.
- Anything else on the first request (404, other status, 5xx, network error, timeout, bad body): today's sign-in form.
- While watching: a 5xx, network error or timeout keeps the last picture and shows "Not updating". A 404, another 4xx or a bad body ends the watch and shows sign-in. There is no retry until a reload.
- "Sign in to control" leaves watching and shows sign-in. After a sign-in the page works as before and never calls the open route. A sign-out or a 401 tries the open route once more.
- A bed with no `rank` or no `risk` is grey with no tag. Figures are coloured by role only.
- With a token present, no open-view request is made at all. A build without `VITE_VIEW_API_URL` is unchanged.

## The nine rules (wire contract, section 9.1), and where they are tested

1. No credential to the open route: `credentials: "omit"`, no `headers` key at all (a simple GET), `redirect: "error"`.
2. No name or title for a figure: staff are named only "Nurse", "Charge nurse", "Physician".
3. Nothing is stored: no browser storage and no cookie. `cache: "no-store"`.
4. No control without a token: the top bar has no speed or Reset, the side panel has no buttons, and `/live` is not read.
5. No other API call without a token.
6. Every string is rendered as React text. A bed label must match `[A-Za-z0-9][A-Za-z0-9 ._-]{0,19}`.
7. Unknown keys are ignored and never read.
8. Poll every 2 s, not faster: the next request is scheduled 2 s after the last answer or failure, one at a time.
9. No logging of the answer.

All are in `src/open-view.test.ts`.

## Limits of the body

At most 64 KiB, read with a byte count, and a 5 s timeout. At most 100 beds, 20 staff and 20 moves. `ward` must equal `W4`. Any field out of shape, any unknown enum value, any number not finite or out of range refuses the whole body.

## Limits

- Synthetic data only. The route serves a synthetic run only.
- The API route may not exist yet, or may be off. Then the page is as before: the sign-in form.
