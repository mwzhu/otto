export function processBoundaryValue(processNames: string[]) {
  return { process_names: uniqueStrings(processNames) };
}

export function ownershipRolesValue(roles: string[]) {
  return { roles: uniqueStrings(roles) };
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}
