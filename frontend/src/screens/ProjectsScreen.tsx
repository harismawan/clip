import { useState } from 'react'
import { Button } from '../components/Button'
import { ago } from '../lib/format'
import { useApp } from '../state/AppContext'

/**
 * Delete, behind a confirm.
 *
 * A project is minutes of CPU and cannot be restored, so a single stray click
 * must not destroy one. The confirm is inline rather than a dialog because this
 * codebase has no modal primitive and one button does not justify inventing one.
 */
function DeleteProject({ id, title }: { id: string; title: string }) {
  const { state, deleteProject } = useApp()
  const [confirming, setConfirming] = useState(false)
  const busy = state.pending === `deleteProject:${id}`

  if (busy) {
    return <span className="flex-none text-[12.5px] text-black/35">Deleting…</span>
  }

  if (confirming) {
    return (
      <span className="flex flex-none items-center gap-2.5">
        <button
          type="button"
          onClick={() => deleteProject(id)}
          className="flex h-10 cursor-pointer items-center text-[12.5px] font-medium text-red-600 hover:text-red-700 md:h-auto"
        >
          Confirm delete
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="flex h-10 cursor-pointer items-center text-[12.5px] font-medium text-black/45 hover:text-ink md:h-auto"
        >
          Cancel
        </button>
      </span>
    )
  }

  return (
    <button
      type="button"
      onClick={() => setConfirming(true)}
      aria-label={`Delete ${title}`}
      className="flex h-10 flex-none cursor-pointer items-center text-[12.5px] font-medium text-black/45 hover:text-red-600 md:h-auto"
    >
      Delete
    </button>
  )
}

export function ProjectsScreen() {
  const { state, goNew, openProject } = useApp()
  const { projects } = state
  const totalClips = projects.reduce((n, p) => n + p.clipCount, 0)

  return (
    <div className="min-h-0 flex-1 overflow-auto px-5 py-[26px] sm:px-7">
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
              /*
                flex-wrap so the actions drop to a second line instead of
                crushing the title. In the delete-confirm state the two extra
                buttons left it about 5px wide.
              */
              className="flex flex-wrap items-center gap-x-3.5 gap-y-2.5 rounded-[18px] border-[1.5px] border-[rgba(23,20,18,.16)] bg-white p-[13px]"
            >
              {project.source.thumbnailUrl ? (
                <img
                  src={project.source.thumbnailUrl}
                  alt=""
                  className="w-[82px] flex-none rounded-[7px] border border-black/12 object-cover"
                  style={{ aspectRatio: '16/9' }}
                />
              ) : (
                <div
                  className="hatch-sand flex w-[82px] flex-none items-center justify-center rounded-[7px] border border-black/12"
                  style={{ aspectRatio: '16/9' }}
                />
              )}
              <div className="min-w-0 flex-1 basis-[150px]">
                <div className="mb-[3px] truncate text-[13.5px] font-semibold text-ink">
                  {project.title}
                </div>
                <div className="truncate text-[11.5px] text-black/45">
                  {project.source.platform} · {project.clipCount} clips ·{' '}
                  {ago(project.createdAt)}
                </div>
              </div>
              {/*
                Keyed per row: opening a project re-fetches its clips, and only
                the row that was clicked should look busy.
              */}
              <button
                type="button"
                onClick={() => openProject(project.id)}
                disabled={state.pending === `openProject:${project.id}`}
                aria-busy={state.pending === `openProject:${project.id}` || undefined}
                className="flex h-10 flex-none cursor-pointer items-center text-[12.5px] font-medium text-violet hover:text-violet-deep disabled:cursor-not-allowed disabled:text-black/35 md:h-auto"
              >
                {state.pending === `openProject:${project.id}` ? 'Opening…' : 'Open'}
              </button>
              <DeleteProject id={project.id} title={project.title} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
