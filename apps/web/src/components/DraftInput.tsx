import { useEffect, useRef, useState, type InputHTMLAttributes } from 'react';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'onBlur'> & {
  /** The committed value, formatted for display. */
  value: string;
  /** Called with the raw text when the field loses focus (or Enter is pressed). */
  onCommit: (text: string) => void;
};

/**
 * A text field that lets people type freely and only converts what they typed when
 * they leave the field. Formatting on every keystroke (e.g. "20.00") fights the cursor:
 * backspace puts the digits straight back and typed amounts come out wrong.
 */
export function DraftInput({ value, onCommit, onKeyDown, ...rest }: Props) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  // Follow outside changes (a reset, a value filled in for the user) unless they're typing.
  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);

  const commit = () => {
    onCommit(draft);
  };

  return (
    <input
      {...rest}
      value={draft}
      onFocus={() => (focused.current = true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        focused.current = false;
        commit();
        // Show the normalised value even when the committed value didn't change.
        setDraft(value);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        onKeyDown?.(e);
      }}
    />
  );
}

/** "$20", "20.5", "1,000" → cents; null when it isn't an amount. */
export function parseDollars(text: string): number | null {
  const n = Number(text.replace(/[$,\s]/g, ''));
  return text.trim() !== '' && Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}
