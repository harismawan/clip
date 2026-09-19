import { Button } from '../components/Button'
import { Logo } from '../components/Logo'
import { useApp } from '../state/AppContext'

const SHOWCASE = [
  { at: '0:14', lift: 'translate-y-0' },
  { at: '0:38', lift: 'translate-y-[18px]' },
  { at: '0:52', lift: '-translate-y-[10px]' },
]

export function LoginScreen() {
  const { signIn } = useApp()

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 bg-white lg:grid-cols-[1.05fr_.95fr]">
      <div className="flex flex-col overflow-auto px-6 py-10 sm:px-[52px] sm:py-12">
        <div className="mb-auto">
          <Logo />
        </div>

        <h1 className="mt-6 mb-2.5 max-w-[420px] font-display text-[38px] leading-[1.1] font-bold tracking-[-0.025em] text-ink">
          Turn one long video into a week of posts.
        </h1>
        <p className="mt-0 mb-7 max-w-[340px] text-[14px] leading-[1.6] text-muted">
          Free while we’re in beta. No card, no watermark.
        </p>

        <form
          className="flex max-w-[352px] flex-col gap-2.5"
          onSubmit={(e) => {
            e.preventDefault()
            signIn()
          }}
        >
          <Button variant="outline" onClick={signIn} className="h-[46px] gap-2.5 text-[14px]">
            <span className="block size-4 rounded-full border-2 border-[#C7C3BB]" />
            Continue with Google
          </Button>
          <Button variant="outline" onClick={signIn} className="h-[46px] gap-2.5 text-[14px]">
            <span className="block size-4 rounded-[3px] border-2 border-[#C7C3BB]" />
            Continue with TikTok
          </Button>

          <div className="my-2 flex items-center gap-3">
            <span className="h-px flex-1 bg-black/10" />
            <span className="text-[11.5px] text-black/35">or</span>
            <span className="h-px flex-1 bg-black/10" />
          </div>

          <label htmlFor="login-email" className="text-[12px] font-medium text-ink-soft">
            Email
          </label>
          <input
            id="login-email"
            type="email"
            placeholder="you@email.com"
            className="h-11 rounded-full border-[1.5px] border-ink px-4 text-[14px] text-ink outline-none focus:border-violet"
          />

          <Button type="submit" className="mt-1 h-[46px] text-[14px]">
            Send me a login link
          </Button>

          <p className="mt-3 mb-0 text-[11.5px] leading-[1.5] text-black/40">
            By continuing you agree to the terms. We only download videos you have the right to use.
          </p>
        </form>
      </div>

      <aside className="hidden flex-col justify-center gap-6 overflow-hidden bg-night px-11 py-12 lg:flex">
        <div className="flex max-w-[380px] gap-3">
          {SHOWCASE.map((tile) => (
            <div
              key={tile.at}
              className={`hatch-night flex flex-1 items-end rounded-[10px] border border-white/8 p-2.5 ${tile.lift}`}
              style={{ aspectRatio: '9/16' }}
            >
              <span className="text-[10px] font-medium text-white/45">{tile.at}</span>
            </div>
          ))}
        </div>
        <blockquote className="m-0 max-w-[300px] font-display text-[19.5px] leading-[1.45] font-medium text-white/80">
          “I record one stream a week and post from it every day. This does the boring part.”
        </blockquote>
        <p className="m-0 text-[12px] text-white/40">Placeholder testimonial</p>
      </aside>
    </div>
  )
}
