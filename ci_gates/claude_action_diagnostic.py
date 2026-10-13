#!/usr/bin/env python3
"""Print safe diagnostics for a failed Claude Code Action execution."""

import json
import sys
from pathlib import Path


def diagnose(execution_file):
    try:
        messages = json.loads(Path(execution_file).read_text())
    except (OSError, json.JSONDecodeError):
        return "Claude API diagnostics unavailable: execution file missing or invalid."

    if not isinstance(messages, list):
        return "Claude API diagnostics unavailable: execution file has an unexpected format."

    result = next(
        (
            message
            for message in reversed(messages)
            if isinstance(message, dict) and message.get("type") == "result"
        ),
        None,
    )
    if result is None:
        return "Claude API diagnostics unavailable: no result message in the execution file."

    status = result.get("api_error_status")
    if (
        isinstance(status, int)
        and not isinstance(status, bool)
        and 100 <= status <= 599
    ):
        status_text = f"HTTP {status}"
        if status == 401:
            guidance = "authentication rejected; check the configured Claude secret."
        elif status == 403:
            guidance = "account or model access denied; check Claude account permissions."
        elif status == 429:
            guidance = "usage/rate limit rejected the request; wait for the limit to reset."
        elif status >= 500:
            guidance = (
                "Claude service returned a server error; retry after checking service status."
            )
        else:
            guidance = "request rejected; check Claude credentials, credits, and model access."
    else:
        status_text = "HTTP status unavailable"
        guidance = "check Claude credentials, credits, and model access."

    first_call_rejected = (
        result.get("is_error") is True
        and result.get("num_turns") == 1
        and result.get("total_cost_usd") == 0
    )
    if first_call_rejected:
        return (
            f"Claude API diagnostics: {status_text}; first Claude API request "
            f"was rejected; {guidance}"
        )

    return f"Claude API diagnostics: {status_text}; {guidance}"


if __name__ == "__main__":
    execution_file = sys.argv[1] if len(sys.argv) > 1 else ""
    print(diagnose(execution_file))
