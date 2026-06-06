export type Validator<T> = (text: string) => { ok: true; value: T } | { ok: false; error: string };

export async function runWithSchema<T>(opts: {
  run: (correction?: string) => Promise<string>;
  validate: Validator<T>;
  maxRetries: number;
}): Promise<T | null> {
  let correction: string | undefined;
  for (let attempt = 0; attempt <= opts.maxRetries; attempt += 1) {
    const text = await opts.run(correction);
    const checked = opts.validate(text);
    if (checked.ok) return checked.value;
    correction = `Your previous output failed validation: ${checked.error}. Return a valid result.`;
  }
  return null;
}
