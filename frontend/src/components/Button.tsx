import type { ButtonHTMLAttributes } from 'react'
import { cn } from '../lib/cn'

type Variant = 'primary' | 'outline' | 'quiet' | 'onDark'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  /**
   * Primary buttons sit in a sand resting state until the action is actually
   * available, then fill with violet. Ignored by the other variants.
   */
  armed?: boolean
}

const base =
  'inline-flex items-center justify-center rounded-full border-[1.5px] font-sans whitespace-nowrap cursor-pointer transition-colors'

const variants: Record<Variant, string> = {
  primary: 'border-ink shadow-stamp font-semibold',
  outline: 'border-ink bg-white font-medium text-ink-soft hover:bg-cream',
  quiet: 'border-[rgba(23,20,18,.5)] bg-white font-medium text-ink-soft hover:bg-cream',
  onDark:
    'border-white/35 bg-transparent font-medium text-white/85 hover:border-white/60 hover:text-white',
}

export function Button({
  variant = 'primary',
  armed = true,
  className,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        base,
        variants[variant],
        variant === 'primary' &&
          (armed
            ? 'bg-violet text-white hover:bg-violet-deep'
            : 'bg-sand-deep text-[rgba(23,20,18,.9)]'),
        className,
      )}
      {...rest}
    />
  )
}
