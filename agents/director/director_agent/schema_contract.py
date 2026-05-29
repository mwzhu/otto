from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from director_agent.planner import director_turn_plan_tool_schema
from director_agent.schemas import (
    ClaimSubjectFields,
    DirectorProcessInventory,
    DirectorTurnPlan,
    Evidence,
)


def check_schema_contract() -> dict[str, Any]:
    errors: list[str] = []
    director_schema = read_json("schemas/director-turn-plan.schema.json")
    slot_schema = read_json("schemas/slot-state.schema.json")
    claim_schema = read_json("schemas/claim.schema.json")
    evidence_schema = read_json("schemas/evidence.schema.json")
    inventory_schema = read_json("schemas/director-process-inventory.schema.json")
    claim_subject_fields = read_json("schemas/claim-subject-fields.json")
    python_schema = DirectorTurnPlan.model_json_schema()
    evidence_python_schema = Evidence.model_json_schema()
    inventory_python_schema = DirectorProcessInventory.model_json_schema()

    compare_equal(errors, "DirectorTurnPlan.required", python_schema.get("required"), director_schema.get("required"))
    compare_key_set(
        errors,
        "DirectorTurnPlan.properties",
        python_schema.get("properties"),
        director_schema.get("properties"),
    )
    compare_equal(
        errors,
        "DirectorTurnPlan.additionalProperties",
        python_schema.get("additionalProperties"),
        director_schema.get("additionalProperties"),
    )
    for field in ["utterance_type", "current_phase", "proposed_next_phase"]:
        compare_equal(
            errors,
            f"DirectorTurnPlan.{field}.enum",
            python_schema["properties"][field].get("enum"),
            director_schema["properties"][field].get("enum"),
        )

    defs = python_schema.get("$defs", {})
    compare_object_schema(errors, "ToolCall", defs.get("ToolCall"), director_schema["properties"]["tool_calls"]["items"])
    compare_object_schema(errors, "DirectorIntent", defs.get("DirectorIntent"), director_schema["properties"]["chosen_intent"])
    compare_object_schema(errors, "SlotUpdate", defs.get("SlotUpdate"), slot_schema)
    compare_object_schema(errors, "PlanClaim", defs.get("PlanClaim"), claim_schema)
    compare_object_schema(errors, "Evidence", evidence_python_schema, evidence_schema)
    for field in ["source_type", "evidence_label"]:
        compare_equal(
            errors,
            f"Evidence.{field}.enum",
            evidence_python_schema["properties"][field].get("enum"),
            evidence_schema["properties"][field].get("enum"),
        )
    compare_object_schema(
        errors,
        "DirectorProcessInventory",
        inventory_python_schema,
        inventory_schema,
    )
    compare_object_schema(
        errors,
        "CandidateProcessInventoryItem",
        inventory_python_schema.get("$defs", {}).get("CandidateProcessInventoryItem"),
        inventory_schema["properties"]["candidate_processes"]["items"],
    )

    try:
        parsed_allowlist = ClaimSubjectFields.model_validate(claim_subject_fields)
        if not parsed_allowlist.allows("candidate_process", "kpi"):
            errors.append("ClaimSubjectFields must allow candidate_process.kpi.")
        for subject_type, field in [
            ("process_node", "evidence_coverage"),
            ("process_edge", "handoff"),
            ("exception", "trigger"),
            ("workaround", "why_it_exists"),
            ("variant", "condition"),
            ("narrative_paragraph", "gap_warning"),
        ]:
            if not parsed_allowlist.allows(subject_type, field):
                errors.append(f"ClaimSubjectFields must allow {subject_type}.{field}.")
    except Exception as exc:  # pragma: no cover - reported by CLI output
        errors.append(f"ClaimSubjectFields failed Pydantic validation: {exc}")

    tool_schema = director_turn_plan_tool_schema()
    forbidden_schema_keys = sorted(find_schema_keys(tool_schema, {"$ref", "$schema", "$id"}))
    if forbidden_schema_keys:
        errors.append(
            "Anthropic DirectorTurnPlan tool schema still contains unresolved JSON Schema keys: "
            + ", ".join(forbidden_schema_keys)
        )

    return {
        "ok": len(errors) == 0,
        "errors": errors,
        "checked": {
            "director_turn_plan_json_schema": "schemas/director-turn-plan.schema.json",
            "slot_state_json_schema": "schemas/slot-state.schema.json",
            "claim_json_schema": "schemas/claim.schema.json",
            "evidence_json_schema": "schemas/evidence.schema.json",
            "director_process_inventory_json_schema": "schemas/director-process-inventory.schema.json",
            "claim_subject_fields": "schemas/claim-subject-fields.json",
            "python_model": "director_agent.schemas.DirectorTurnPlan",
            "python_evidence_model": "director_agent.schemas.Evidence",
            "python_director_process_inventory_model": "director_agent.schemas.DirectorProcessInventory",
            "anthropic_tool_schema": "director_agent.planner.director_turn_plan_tool_schema",
        },
    }


def compare_object_schema(
    errors: list[str],
    name: str,
    python_schema: Any,
    json_schema: Any,
) -> None:
    if not isinstance(python_schema, dict) or not isinstance(json_schema, dict):
        errors.append(f"{name} schema missing from one side of the contract.")
        return
    compare_equal(errors, f"{name}.required", python_schema.get("required"), json_schema.get("required"))
    compare_key_set(errors, f"{name}.properties", python_schema.get("properties"), json_schema.get("properties"))
    compare_equal(
        errors,
        f"{name}.additionalProperties",
        python_schema.get("additionalProperties"),
        json_schema.get("additionalProperties"),
    )


def compare_equal(errors: list[str], label: str, actual: Any, expected: Any) -> None:
    if actual != expected:
        errors.append(f"{label} mismatch: actual={actual!r} expected={expected!r}")


def compare_key_set(errors: list[str], label: str, actual: Any, expected: Any) -> None:
    actual_keys = sorted((actual or {}).keys()) if isinstance(actual, dict) else []
    expected_keys = sorted((expected or {}).keys()) if isinstance(expected, dict) else []
    if actual_keys != expected_keys:
        errors.append(f"{label} keys mismatch: actual={actual_keys!r} expected={expected_keys!r}")


def find_schema_keys(value: Any, forbidden: set[str]) -> set[str]:
    found: set[str] = set()
    if isinstance(value, dict):
        found.update(key for key in value if key in forbidden)
        for child in value.values():
            found.update(find_schema_keys(child, forbidden))
    elif isinstance(value, list):
        for child in value:
            found.update(find_schema_keys(child, forbidden))
    return found


def read_json(relative_path: str) -> Any:
    return json.loads((Path(__file__).resolve().parents[3] / relative_path).read_text())


def main() -> None:
    result = check_schema_contract()
    print(json.dumps(result, indent=2, sort_keys=True))
    raise SystemExit(0 if result["ok"] else 1)


if __name__ == "__main__":
    main()
