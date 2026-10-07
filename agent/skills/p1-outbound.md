# P1 outbound

Load this when preparing any text that might leave the firm.

- Call `mask_preview` before talking about what a provider would see.
- Call `classification_policy` before assuming a rank may leave.
- Classification ranks: public 0, internal 1, confidential 2, privileged 3, privileged-restricted 4. Compare ranks, never label strings.
- Party names redact only when the caller supplies them. Do not invent NER for "Ali" or "Khan".
- TODO(firm): DPA / residency. The DPA table is empty. Per L18 §4.6, public and internal may go to any configured provider; confidential and privileged stay blocked until a DPA is recorded; privileged-restricted until an in-region provider is recorded.
