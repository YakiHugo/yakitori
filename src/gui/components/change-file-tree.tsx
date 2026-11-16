import { ChevronRight, FileCode2 } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import type { WorkspaceGitEntry } from "../../protocol/workspace.ts"
import { ChangeStats } from "./workspace-change-summary.tsx"
import "./change-file-tree.css"

export type ChangeFileItem = Readonly<{
  entry: WorkspaceGitEntry
  staged: boolean
}>

type ChangeFileTreeProps = Readonly<{
  items: readonly ChangeFileItem[]
  selectedKey: string | undefined
  onSelect(item: ChangeFileItem): void
}>

type Directory = {
  name: string
  path: string
  directories: Map<string, Directory>
  files: ChangeFileItem[]
}

export function ChangeFileTree(props: ChangeFileTreeProps) {
  const navigation = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!props.selectedKey) return
    let frame: number
    const reveal = () => {
      cancelAnimationFrame(frame)
      // Wait for ancestor expansion and layout before scrolling the selection.
      frame = requestAnimationFrame(() => {
        navigation.current
          ?.querySelector<HTMLElement>('[aria-current="true"]')
          ?.scrollIntoView({ block: "nearest" })
      })
    }
    const observer = new ResizeObserver(reveal)
    const viewport = navigation.current?.parentElement
    if (viewport) observer.observe(viewport)
    reveal()
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [props.selectedKey])
  const root: Directory = {
    name: "",
    path: "",
    directories: new Map(),
    files: [],
  }
  const sidesByPath = new Map<string, Set<boolean>>()
  for (const item of props.items) {
    const sides = sidesByPath.get(item.entry.path) ?? new Set<boolean>()
    sides.add(item.staged)
    sidesByPath.set(item.entry.path, sides)
    const parts = item.entry.path.split("/")
    parts.pop()
    let directory = root
    for (const name of parts) {
      let child = directory.directories.get(name)
      if (!child) {
        child = {
          name,
          path: directory.path ? `${directory.path}/${name}` : name,
          directories: new Map(),
          files: [],
        }
        directory.directories.set(name, child)
      }
      directory = child
    }
    directory.files.push(item)
  }

  return (
    <nav ref={navigation} className="change-tree" aria-label="Changed files">
      <DirectoryContents
        directory={root}
        sidesByPath={sidesByPath}
        selectedKey={props.selectedKey}
        onSelect={props.onSelect}
      />
    </nav>
  )
}

type DirectoryContentsProps = Readonly<{
  directory: Directory
  sidesByPath: Map<string, Set<boolean>>
  selectedKey: string | undefined
  onSelect(item: ChangeFileItem): void
}>

function DirectoryContents(props: DirectoryContentsProps) {
  return (
    <ul className="change-tree-list">
      {[...props.directory.directories.values()]
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((directory) => (
          <DirectoryRow key={directory.path} {...props} directory={directory} />
        ))}
      {props.directory.files
        .toSorted(
          (left, right) =>
            left.entry.path.localeCompare(right.entry.path) ||
            Number(right.staged) - Number(left.staged),
        )
        .map((item) => {
          const key = `${item.staged ? "staged" : "unstaged"}:${item.entry.path}`
          return (
            <li key={key} className="change-tree-item">
              <button
                type="button"
                className="change-tree-row change-tree-file"
                aria-label={`${item.entry.path}, ${item.staged ? "staged" : "unstaged"}`}
                aria-current={props.selectedKey === key ? true : undefined}
                title={item.entry.path}
                onClick={() => props.onSelect(item)}
              >
                <FileCode2
                  size={14}
                  className="change-tree-file-icon"
                  aria-hidden="true"
                />
                <span className="change-tree-name">
                  {item.entry.path.slice(item.entry.path.lastIndexOf("/") + 1)}
                </span>
                {props.sidesByPath.get(item.entry.path)?.size === 2 ? (
                  <span className="change-tree-scope">
                    {item.staged ? "Staged" : "Unstaged"}
                  </span>
                ) : null}
                <ChangeStats
                  stats={
                    item.staged
                      ? item.entry.stagedStats
                      : item.entry.unstagedStats
                  }
                />
              </button>
            </li>
          )
        })}
    </ul>
  )
}

function DirectoryRow(props: DirectoryContentsProps) {
  const [open, setOpen] = useState(true)
  const { selectedKey } = props
  const directoryPath = props.directory.path
  useEffect(() => {
    if (
      selectedKey?.startsWith(`staged:${directoryPath}/`) ||
      selectedKey?.startsWith(`unstaged:${directoryPath}/`)
    ) {
      setOpen(true)
    }
  }, [selectedKey, directoryPath])
  let directory = props.directory
  let name = directory.name
  while (directory.files.length === 0 && directory.directories.size === 1) {
    const child = directory.directories.values().next().value
    if (!child) break
    name += `/${child.name}`
    directory = child
  }

  return (
    <li className="change-tree-item">
      <button
        type="button"
        className="change-tree-row change-tree-directory"
        aria-expanded={open}
        title={directory.path}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRight
          size={13}
          className="change-tree-chevron"
          aria-hidden="true"
        />
        <span className="change-tree-name">{name}</span>
      </button>
      <div className="change-tree-children" hidden={!open}>
        <DirectoryContents {...props} directory={directory} />
      </div>
    </li>
  )
}
