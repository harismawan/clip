import type { ReactNode } from 'react'
import { Button } from '../components/Button'
import { OptionChip } from '../components/OptionChip'
import { Toggle } from '../components/Toggle'
import { LENGTHS, RATIOS } from '../data/fixtures'
import { cn } from '../lib/cn'
import { formatsLabel } from '../lib/derive'
import { useApp } from '../state/AppContext'

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-[20px] border-[1.5px] border-[rgba(23,20,18,.16)] bg-white">
      <h2 className="m-0 border-b border-black/7 px-[18px] py-3.5 text-[11px] font-semibold tracking-[.07em] text-black/40 uppercase">
        {title}
      </h2>
      {children}
    </section>
  )
}

function Row({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('px-[18px] py-4', className)}>{children}</div>
}

function RowTitle({ title, hint }: { title: string; hint: string }) {
  return (
    <span className="block">
      <span className="block text-[13px] font-medium text-ink">{title}</span>
      <span className="block text-[11.5px] text-black/45">{hint}</span>
    </span>
  )
}

const divider = 'border-b border-black/7'

export function SettingsScreen() {
  const {
    state,
    cycleLength,
    toggleFormat,
    toggleSubs,
    toggleEmail,
    say,
    setPwCurrent,
    setPwNext,
    updatePassword,
  } = useApp()

  const pwTooShort = state.pwNext.length > 0 && state.pwNext.length < 8
  const pwReady = Boolean(state.pwCurrent) && state.pwNext.length >= 8

  return (
    <div className="min-h-0 flex-1 overflow-auto px-5 py-[26px] sm:px-7">
      <h1 className="m-0 mb-5 font-display text-[27px] font-bold tracking-[-0.025em] text-ink">
        Settings
      </h1>

      <div className="flex max-w-[520px] flex-col gap-[18px]">
        <Card title="Defaults for new videos">
          <Row className={cn('flex items-center justify-between gap-3', divider)}>
            <RowTitle title="Clip length" hint="Applied to every new job" />
            <Button variant="quiet" onClick={cycleLength} className="h-8 px-3 text-[12.5px]">
              {LENGTHS[state.lengthIdx]} ▾
            </Button>
          </Row>

          <Row className={divider}>
            <div className="mb-[3px] text-[13px] font-medium text-ink">Formats to render</div>
            <div className="mb-[11px] text-[11.5px] text-black/45">
              Currently {formatsLabel(state.formats)}
            </div>
            <div className="flex max-w-[300px] gap-1.5">
              {RATIOS.map((label) => (
                <OptionChip
                  key={label}
                  selected={state.formats[label]}
                  onClick={() => toggleFormat(label)}
                  className="h-[34px] rounded-full border-[1.5px]"
                >
                  {label}
                </OptionChip>
              ))}
            </div>
          </Row>

          <button
            type="button"
            onClick={toggleSubs}
            className={cn(
              'flex w-full cursor-pointer items-center justify-between gap-3 px-[18px] py-4 text-left',
              divider,
            )}
          >
            <RowTitle title="Burn in subtitles" hint="Bold, centred, bottom third" />
            <Toggle on={state.subs} label="Burn in subtitles" />
          </button>

          <button
            type="button"
            onClick={toggleEmail}
            className="flex w-full cursor-pointer items-center justify-between gap-3 px-[18px] py-4 text-left"
          >
            <RowTitle
              title="Email me when a job finishes"
              hint="Most jobs take under 10 minutes"
            />
            <Toggle on={state.emailMe} label="Email me when a job finishes" />
          </button>
        </Card>

        <Card title="Account">
          <Row className={cn('flex items-center gap-3', divider)}>
            <div className="size-[34px] flex-none rounded-full bg-sand-deeper" />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium text-ink">you@email.com</div>
              <div className="text-[11.5px] text-black/45">Signed in with a login link</div>
            </div>
          </Row>
          <Row className="flex items-center justify-between gap-3">
            <span className="text-[13px] font-medium text-ink">Delete account and all clips</span>
            <button
              type="button"
              onClick={() => say('Not in this prototype.')}
              className="cursor-pointer text-[12.5px] font-medium text-danger"
            >
              Delete
            </button>
          </Row>
        </Card>

        <Card title="Password">
          <form
            className="flex flex-col gap-[11px] px-[18px] py-4"
            onSubmit={(e) => {
              e.preventDefault()
              updatePassword()
            }}
          >
            <label htmlFor="pw-current" className="text-[12px] font-medium text-ink-soft">
              Current password
            </label>
            <input
              id="pw-current"
              type="password"
              autoComplete="current-password"
              value={state.pwCurrent}
              onChange={(e) => setPwCurrent(e.target.value)}
              placeholder="••••••••"
              className="h-10 rounded-full border-[1.5px] border-[rgba(23,20,18,.3)] px-3.5 text-[13px] text-ink outline-none focus:border-violet"
            />

            <label htmlFor="pw-next" className="text-[12px] font-medium text-ink-soft">
              New password
            </label>
            <input
              id="pw-next"
              type="password"
              autoComplete="new-password"
              value={state.pwNext}
              onChange={(e) => setPwNext(e.target.value)}
              placeholder="At least 8 characters"
              aria-describedby="pw-hint"
              className="h-10 rounded-full border-[1.5px] border-[rgba(23,20,18,.3)] px-3.5 text-[13px] text-ink outline-none focus:border-violet"
            />

            <p
              id="pw-hint"
              className={cn('m-0 text-[11.5px]', pwTooShort ? 'text-danger' : 'text-black/42')}
            >
              {pwTooShort
                ? 'A bit longer — 8 characters minimum.'
                : 'You’ll stay signed in on this device.'}
            </p>

            <Button type="submit" armed={pwReady} className="h-10 self-start px-[18px] text-[13px]">
              Update password
            </Button>
          </form>
        </Card>
      </div>
    </div>
  )
}
