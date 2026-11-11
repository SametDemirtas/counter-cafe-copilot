// Small grammar helpers shared by the brief and the demo brain's templates.

// "Tomatoes (kg)" reads as "Tomatoes are"; "Delivery surcharge" as "... is".
export function subject(item: string): string {
  const name = item.replace(/\s*\([^)]*\)\s*$/, "");
  return `${name} ${/s$/i.test(name) ? "are" : "is"}`;
}
