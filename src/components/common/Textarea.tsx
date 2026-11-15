import { type TextareaHTMLAttributes, forwardRef } from 'react';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
  helperText?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ label, error, helperText, className = '', id, rows = 3, ...props }, ref) => {
    const textareaId = id || (label ? label.toLowerCase().replace(/\s+/g, '-') : undefined);

    return (
      <div className="w-full">
        {label && (
          <label htmlFor={textareaId} className="mb-2 block text-[14px] font-medium leading-snug text-ink">
            {label} {props.required && <span className="text-[#8E3B32] dark:text-rose-400">*</span>}
          </label>
        )}
        <textarea
          id={textareaId}
          ref={ref}
          rows={rows}
          className={`block w-full border bg-surface px-3 py-3 text-[16px] leading-relaxed text-ink transition-colors placeholder:text-ink-muted focus:outline-none focus:border-indigo-600 dark:focus:border-indigo-500 disabled:bg-paper-sunken disabled:text-ink-muted ${
            error ? 'border-[#8E3B32] dark:border-rose-500 focus:border-[#8E3B32] dark:focus:border-rose-500' : 'border-line'
          } ${className}`}
          {...props}
        />
        {error ? (
          <p className="mt-1.5 text-[13px] font-medium text-[#8E3B32] dark:text-rose-400">{error}</p>
        ) : helperText ? (
          <p className="mt-1.5 text-[13px] text-ink-secondary">{helperText}</p>
        ) : null}
      </div>
    );
  }
);

Textarea.displayName = 'Textarea';
