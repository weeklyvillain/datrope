export function ErrorText({ error }: { error?: string }) {
  return error ? <p className="my-1 text-destructive" role="alert">{error}</p> : null;
}
