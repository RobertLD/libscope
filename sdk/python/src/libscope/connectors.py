"""Connector management helpers for libscope SDK."""

from __future__ import annotations

from typing import Any, Dict


def build_connector_config(connector: str, **kwargs: Any) -> Dict[str, Any]:
    """Build a connector configuration payload.

    Args:
        connector: Connector name (e.g., "obsidian", "onenote").
        **kwargs: Connector-specific configuration options.

    Returns:
        A dict suitable for posting to the connector sync endpoint.
    """
    return {"connector": connector, "config": kwargs}
