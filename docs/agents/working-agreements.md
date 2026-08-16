# Working agreements

Use these constraints when implementing changes in this repository.

## Before editing

- State assumptions that materially affect the implementation.
- If the request has multiple materially different interpretations, present them before choosing one.
- Prefer the simplest approach that fully satisfies the request; call out a simpler alternative when it changes the tradeoff.

## Scope discipline

- Do not add features, abstractions, or configurability beyond the request.
- Do not refactor, reformat, or clean up adjacent code.
- Match the existing style in files you touch.
- Remove imports, variables, functions, and files only when your change makes them unused.
- Mention unrelated dead code rather than deleting it.

## Verification

- Define a concrete success check before implementing a multi-step change.
- For bug fixes, reproduce the failure when practical and verify the fix.
- For refactors, run relevant checks before and after when practical.
- Use the narrowest relevant tests first, then broaden verification in proportion to risk.
