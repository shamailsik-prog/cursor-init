# P1 outbound

Load this when preparing any text that might leave the firm.

- Call `mask_preview` before talking about what a provider would see.
- Call `classification_policy` before assuming a rank may leave.
- Classification ranks: public 0, internal 1, confidential 2, privileged 3, privileged-restricted 4. Compare ranks, never label strings.
- Party names redact only when the caller supplies them. Do not invent NER for "Ali" or "Khan".
- TODO(firm): DPA / residency. The DPA table is empty. Internal+ stays blocked.
