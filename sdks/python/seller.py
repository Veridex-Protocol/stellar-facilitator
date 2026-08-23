"""
Veridex SDK - Python Seller Helpers
License: Apache-2.0

Helper functions for resource servers to declare Bazaar discovery metadata
"""

import re
from typing import List, Optional, Dict, Any
from urllib.parse import unquote


class BazaarMetadata:
    """Bazaar discovery metadata"""

    def __init__(
        self,
        description: str,
        input_spec: Dict[str, Any],
        service_name: Optional[str] = None,
        tags: Optional[List[str]] = None,
        icon_url: Optional[str] = None,
        route_template: Optional[str] = None,
        mime_type: str = "application/json",
        output_spec: Optional[Dict[str, Any]] = None,
    ):
        self.description = description
        self.service_name = service_name
        self.tags = sanitize_tags(tags) if tags else []
        self.icon_url = icon_url
        self.route_template = route_template
        self.mime_type = mime_type
        self.input_spec = input_spec
        self.output_spec = output_spec

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization"""
        return {
            "description": self.description,
            "serviceName": self.service_name,
            "tags": self.tags,
            "iconUrl": self.icon_url,
            "routeTemplate": self.route_template,
            "mimeType": self.mime_type,
            "inputSpec": self.input_spec,
            "outputSpec": self.output_spec,
        }


def create_bazaar_metadata(
    description: str,
    input_spec: Dict[str, Any],
    service_name: Optional[str] = None,
    tags: Optional[List[str]] = None,
    icon_url: Optional[str] = None,
    route_template: Optional[str] = None,
    mime_type: str = "application/json",
    output_spec: Optional[Dict[str, Any]] = None,
) -> BazaarMetadata:
    """
    Create Bazaar discovery metadata with automatic validation

    Args:
        description: Service description
        input_spec: JSON Schema for input parameters
        service_name: Optional service name (max 32 chars, printable ASCII)
        tags: Optional tags (max 5, max 32 chars each)
        icon_url: Optional icon URL (no IP literals/localhost)
        route_template: Optional route template (no path traversal)
        mime_type: Response MIME type (default: application/json)
        output_spec: Optional JSON Schema for output

    Returns:
        BazaarMetadata instance
    """
    return BazaarMetadata(
        description=description,
        input_spec=input_spec,
        service_name=service_name,
        tags=tags,
        icon_url=icon_url,
        route_template=route_template,
        mime_type=mime_type,
        output_spec=output_spec,
    )


def is_valid_service_name(service_name: str) -> bool:
    """
    Validate service name (printable ASCII, max 32 chars)

    Args:
        service_name: Service name to validate

    Returns:
        True if valid
    """
    if len(service_name) > 32:
        return False

    # Check for printable ASCII (0x20-0x7E)
    return bool(re.match(r"^[\x20-\x7e]+$", service_name))


def sanitize_tags(tags: List[str]) -> List[str]:
    """
    Sanitize tags array (printable ASCII, max 32 chars, max 5 tags, deduplicated)

    Args:
        tags: Tags list

    Returns:
        Sanitized tags list
    """
    seen = set()
    sanitized = []

    for tag in tags:
        # Skip if already seen (case-insensitive)
        normalized = tag.lower()
        if normalized in seen:
            continue

        # Validate printable ASCII and length
        if re.match(r"^[\x20-\x7e]+$", tag) and len(tag) <= 32:
            sanitized.append(tag)
            seen.add(normalized)

        # Max 5 tags
        if len(sanitized) >= 5:
            break

    return sanitized


def is_valid_icon_url(icon_url: str) -> bool:
    """
    Validate icon URL (no IP literals, localhost, decimal/hex IPs)

    Args:
        icon_url: Icon URL to validate

    Returns:
        True if valid
    """
    try:
        from urllib.parse import urlparse

        url = urlparse(icon_url)
        hostname = url.hostname

        if not hostname:
            return False

        # Reject IP literals
        if re.match(r"^\d+\.\d+\.\d+\.\d+$", hostname):
            return False

        # Reject localhost and loopback
        if hostname.lower() in ["localhost", "ip6-loopback"]:
            return False

        # Reject decimal/hex encoded IPs
        if re.match(r"^(0x[0-9a-f]+|\d+)$", hostname, re.IGNORECASE):
            return False

        return True
    except Exception:
        return False


def is_valid_route_template(route_template: str) -> bool:
    """
    Validate route template (no path traversal, no scheme injection)

    Args:
        route_template: Route template to validate

    Returns:
        True if valid
    """
    try:
        decoded = unquote(route_template)
    except Exception:
        return False

    # Reject path traversal
    if ".." in decoded:
        return False

    # Reject URL scheme injection
    if "://" in decoded:
        return False

    return True


def validate_bazaar_metadata(metadata: BazaarMetadata) -> Dict[str, Any]:
    """
    Validate complete Bazaar metadata

    Args:
        metadata: Metadata to validate

    Returns:
        Dictionary with 'valid' (bool) and 'errors' (List[str])
    """
    errors = []

    # Validate serviceName
    if metadata.service_name and not is_valid_service_name(metadata.service_name):
        errors.append("serviceName must be printable ASCII and max 32 characters")

    # Validate tags
    if metadata.tags:
        if len(metadata.tags) > 5:
            errors.append("maximum 5 tags allowed")
        for tag in metadata.tags:
            if not re.match(r"^[\x20-\x7e]+$", tag) or len(tag) > 32:
                errors.append(f"invalid tag: {tag}")

    # Validate iconUrl
    if metadata.icon_url and not is_valid_icon_url(metadata.icon_url):
        errors.append("iconUrl must not contain IP literals, localhost, or encoded IPs")

    # Validate routeTemplate
    if metadata.route_template and not is_valid_route_template(metadata.route_template):
        errors.append(
            "routeTemplate must not contain path traversal (..) or scheme injection (://)"
        )

    return {"valid": len(errors) == 0, "errors": errors}
