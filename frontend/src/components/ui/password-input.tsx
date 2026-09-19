import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Eye, EyeOff } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'

const PasswordInput = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => {
    const { t } = useTranslation()
    const [visible, setVisible] = React.useState(false)
    const label = visible ? t('common.hidePassword', 'Hide password') : t('common.showPassword', 'Show password')
    return (
      <div className="relative min-w-0">
        <Input
          ref={ref}
          type={visible ? 'text' : 'password'}
          className={cn('w-full min-w-0 max-w-full pr-10', className)}
          {...props}
        />
        <button
          type="button"
          tabIndex={-1}
          onClick={() => setVisible((v) => !v)}
          title={label}
          aria-label={label}
          aria-pressed={visible}
          className="absolute inset-y-0 end-0 flex w-9 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
        >
          {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
    )
  },
)
PasswordInput.displayName = 'PasswordInput'

export { PasswordInput }