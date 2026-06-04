export function processBoundaryValue(processNames: string[]) {
  return { process_names: uniqueStrings(processNames) };
}

export function ownershipRolesValue(roles: string[]) {
  return { roles: uniqueStrings(roles) };
}

export function normalizeDirectorSlotValue(slotPath: string, value: unknown) {
  if (slotPath === "scope.boundaries") {
    return normalizeProcessBoundaryValue(value);
  }
  if (slotPath === "ownership.roles") {
    return normalizeOwnershipRolesValue(value);
  }
  return value;
}

function normalizeProcessBoundaryValue(value: unknown) {
  if (!isRecord(value)) return value;
  if (Array.isArray(value.process_names)) {
    return {
      ...value,
      process_names: uniqueStrings(value.process_names.filter(isString)),
    };
  }
  if (Array.isArray(value.processNames)) {
    return processBoundaryValue(value.processNames.filter(isString));
  }
  const processName =
    stringFromValue(value.process_name) ??
    stringFromValue(value.process) ??
    stringFromValue(value.name);
  if (processName) {
    return processBoundaryValue([processName]);
  }
  if (typeof value.text === "string") {
    return processBoundaryValue([value.text]);
  }
  return value;
}

function normalizeOwnershipRolesValue(value: unknown) {
  if (!isRecord(value)) return value;
  if (Array.isArray(value.roles)) {
    return {
      ...value,
      roles: uniqueStrings(value.roles.filter(isString)),
    };
  }
  const role =
    stringFromValue(value.role) ??
    stringFromValue(value.owner) ??
    stringFromValue(value.owner_role) ??
    stringFromValue(value.team) ??
    stringFromValue(value.department);
  if (role) {
    return ownershipRolesValue([role]);
  }
  if (typeof value.text === "string") {
    return ownershipRolesValue([value.text]);
  }
  return value;
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function stringFromValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}
