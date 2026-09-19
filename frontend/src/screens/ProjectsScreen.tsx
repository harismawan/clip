import { Button } from '../components/Button'
import { SOURCES } from '../data/fixtures'
import { ago } from '../lib/format'
import { useApp } from '../state/AppContext'

export function ProjectsScreen() {
  const { state, goNew, openProject } = useApp()
  const { projects } = state
  const totalClips = projects.reduce((n, p) => n + p.clips.length, 0)

  return (
    <div className="min-h-0 flex-1 overflow-auto px-7 py-[26px]">
      <div className="mb-[22px] flex flex-wrap items-baseline gap-3">
        <h1 className="m-0 font-display text-[27px] font-bold tracking-[-0.025em] text-ink">
          Your projects
        </h1>
        {projects.length > 0 && (
          <span className="text-[12.5px] text-black/42">
            {projects.length} {projects.length === 1 ? 'video' : 'videos'} · {totalClips} clips
          </span>
        )}
      </div>

      {projects.length === 0 ? (
        <div className="flex max-w-[860px] flex-col items-start gap-3.5 rounded-[18px] border-[1.5px] border-dashed border-[rgba(23,20,18,.22)] bg-white p-7">
          <p className="m-0 text-[13.5px] text-muted">
            Nothing here yet. Paste a link and your finished clips land here.
          </p>
          <Button onClick={goNew} className="h-10 px-4 text-[13px]">
            + New video
          </Button>
        </div>
      ) : (
        <ul className="m-0 flex max-w-[860px] list-none flex-col gap-[9px] p-0">
          {projects.map((project) => (
            <li
              key={project.id}
              className="flex items-center gap-3.5 rounded-[18px] border-[1.5px] border-[rgba(23,20,18,.16)] bg-white p-[13px]"
            >
              <div
                className="hatch-sand flex w-[82px] flex-none items-center justify-center rounded-[7px] border border-black/12"
                style={{ aspectRatio: '16/9' }}
              />
              <div className="min-w-0 flex-1">
                <div className="mb-[3px] truncate text-[13.5px] font-semibold text-ink">
                  {project.title}
                </div>
                <div className="text-[11.5px] text-black/45">
                  {SOURCES[project.source].platform} · {project.clips.length} clips ·{' '}
                  {ago(project.createdAt)}
                </div>
              </div>
              <button
                type="button"
                onClick={() => openProject(project.id)}
                className="flex-none cursor-pointer text-[12.5px] font-medium text-violet hover:text-violet-deep"
              >
                Open
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
