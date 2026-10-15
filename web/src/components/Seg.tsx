// Segmented control: a row of toggle buttons where one is selected.

interface Props<T extends string | number> {
  options: [T, string][];
  value: T;
  onChange: (v: T) => void;
  size?: "md" | "lg";
  label?: string;
  labelledBy?: string;
}

export function Seg<T extends string | number>({ options, value, onChange, size, label, labelledBy }: Props<T>) {
  return (
    <div className={"seg " + (size || "")} role="group" aria-label={label} aria-labelledby={labelledBy}>
      {options.map(([v, text]) => (
        <button key={String(v)} type="button" aria-pressed={v === value} onClick={() => onChange(v)}>{text}</button>
      ))}
    </div>
  );
}
