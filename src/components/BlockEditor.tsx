import { Fragment, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Copy, Plus, Trash2 } from "lucide-react";
import {
  BLOCK_TYPE_LABEL,
  emptyBlock,
  type BlockType,
  type ListBlock,
  type ListItem,
  type ProfileBlock,
} from "../lib/profileBlocks";

type BlockEditorProps = {
  blocks: ProfileBlock[];
  onChange: (blocks: ProfileBlock[]) => void;
  uploading: boolean;
  onImageUpload: (blockId: string, file: File) => void;
  photoUrls: Record<string, string>;
};

type AutoGrowTextareaProps = {
  value: string;
  onChange: (value: string) => void;
};

function AutoGrowTextarea({ value, onChange }: AutoGrowTextareaProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const textarea = ref.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.max(textarea.scrollHeight, 78)}px`;
  }, [value]);

  function setCursor(position: number) {
    requestAnimationFrame(() => ref.current?.setSelectionRange(position, position));
  }

  return (
    <textarea
      ref={ref}
      className="field__input blockEditor__textarea"
      rows={3}
      placeholder="文章を入力。改行・**太字**・[表示文](URL)が使えます"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
        const textarea = event.currentTarget;
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const lineStart = value.lastIndexOf("\n", start - 1) + 1;
        const nextBreak = value.indexOf("\n", start);
        const lineEnd = nextBreak === -1 ? value.length : nextBreak;
        const currentLine = value.slice(lineStart, lineEnd);

        if (/^\s*-\s*$/.test(currentLine)) {
          event.preventDefault();
          const next = `${value.slice(0, lineStart)}${value.slice(lineEnd)}`;
          onChange(next);
          setCursor(lineStart);
          return;
        }

        const marker = currentLine.match(/^(\s*)-\s+\S/);
        if (!marker) return;
        event.preventDefault();
        const insertion = `\n${marker[1]}- `;
        const next = `${value.slice(0, start)}${insertion}${value.slice(end)}`;
        onChange(next);
        setCursor(start + insertion.length);
      }}
    />
  );
}

type InsertControlProps = {
  position: number;
  open: boolean;
  persistent?: boolean;
  onToggle: () => void;
  onInsert: (type: BlockType, position: number) => void;
};

function InsertControl({
  position,
  open,
  persistent = false,
  onToggle,
  onInsert,
}: InsertControlProps) {
  return (
    <div className={`blockEditor__insert${persistent ? " blockEditor__insert--persistent" : ""}`}>
      <button
        type="button"
        className="blockEditor__insertButton"
        onClick={onToggle}
        aria-label={persistent ? "末尾にブロックを追加" : "この位置にブロックを追加"}
        aria-expanded={open}
      >
        <Plus size={persistent ? 16 : 14} aria-hidden="true" />
        {persistent ? <span>ブロックを追加</span> : null}
      </button>
      {open ? (
        <div className="blockEditor__insertMenu" role="group" aria-label="追加するブロックの種類">
          {(Object.keys(BLOCK_TYPE_LABEL) as BlockType[]).map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => onInsert(type, position)}
            >
              {BLOCK_TYPE_LABEL[type]}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function cloneBlock(block: ProfileBlock): ProfileBlock {
  const id = emptyBlock(block.type).id;
  if (block.type === "image") {
    return { ...block, id, images: block.images.map((image) => ({ ...image })) };
  }
  if (block.type === "list") {
    return {
      ...block,
      id,
      items: block.items.map((item) => ({ ...item, children: item.children ? [...item.children] : undefined })),
    };
  }
  return { ...block, id };
}

function LayoutPicker({
  value,
  onChange,
}: {
  value: ProfileBlock["layout"];
  onChange: (layout: "full" | "left" | "right") => void;
}) {
  const selected = value ?? "full";
  return (
    <div className="blockEditor__layout">
      <span className="blockEditor__optionLabel">幅</span>
      <div className="blockEditor__segments" role="group" aria-label="ブロックの幅">
        {([
          ["full", "全幅"],
          ["left", "左半分"],
          ["right", "右半分"],
        ] as const).map(([layout, label]) => (
          <button
            key={layout}
            type="button"
            className={selected === layout ? "is-selected" : ""}
            onClick={() => onChange(layout)}
            aria-pressed={selected === layout}
          >
            {label}
          </button>
        ))}
      </div>
      {selected === "left" ? (
        <span className="blockEditor__layoutHint">次の「右半分」ブロックと横に並びます</span>
      ) : null}
      {selected === "right" ? (
        <span className="blockEditor__layoutHint">直前が「左半分」の時だけ横に並びます</span>
      ) : null}
    </div>
  );
}

function ListEditor({ block, onChange }: { block: ListBlock; onChange: (block: ListBlock) => void }) {
  function updateParent(index: number, text: string) {
    onChange({
      ...block,
      items: block.items.map((item, itemIndex) => (itemIndex === index ? { ...item, text } : item)),
    });
  }

  function updateChild(parentIndex: number, childIndex: number, text: string) {
    onChange({
      ...block,
      items: block.items.map((item, itemIndex) =>
        itemIndex === parentIndex
          ? {
              ...item,
              children: item.children?.map((child, index) => (index === childIndex ? text : child)),
            }
          : item,
      ),
    });
  }

  function indentParent(index: number) {
    if (index === 0) return;
    const items: ListItem[] = block.items.map((item) => ({
      ...item,
      children: item.children ? [...item.children] : undefined,
    }));
    const [item] = items.splice(index, 1);
    const previous = items[index - 1];
    previous.children = [...(previous.children ?? []), item.text, ...(item.children ?? [])];
    onChange({ ...block, items });
  }

  function outdentChild(parentIndex: number, childIndex: number) {
    const items: ListItem[] = block.items.map((item) => ({
      ...item,
      children: item.children ? [...item.children] : undefined,
    }));
    const parent = items[parentIndex];
    const child = parent.children?.[childIndex];
    if (child === undefined) return;
    parent.children?.splice(childIndex, 1);
    if (parent.children?.length === 0) parent.children = undefined;
    items.splice(parentIndex + 1, 0, { text: child });
    onChange({ ...block, items });
  }

  return (
    <div className="blockEditor__listEditor">
      <div className="blockEditor__segments" role="group" aria-label="箇条書きの形式">
        <button
          type="button"
          className={!block.ordered ? "is-selected" : ""}
          aria-pressed={!block.ordered}
          onClick={() => onChange({ ...block, ordered: undefined })}
        >
          ・箇条書き
        </button>
        <button
          type="button"
          className={block.ordered ? "is-selected" : ""}
          aria-pressed={block.ordered === true}
          onClick={() => onChange({ ...block, ordered: true })}
        >
          1. 番号付き
        </button>
      </div>
      <div className="blockEditor__listItems">
        {block.items.map((item, itemIndex) => (
          <Fragment key={`${block.id}_item_${itemIndex}`}>
            <div className="blockEditor__listRow">
              <span aria-hidden="true">{block.ordered ? `${itemIndex + 1}.` : "•"}</span>
              <input
                className="field__input field__input--xs"
                value={item.text}
                placeholder="項目を入力"
                aria-label={`項目${itemIndex + 1}`}
                onChange={(event) => updateParent(itemIndex, event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Tab" && !event.shiftKey && itemIndex > 0) {
                    event.preventDefault();
                    indentParent(itemIndex);
                  }
                }}
              />
              <button
                type="button"
                className="blockEditor__iconButton"
                onClick={() =>
                  onChange({ ...block, items: block.items.filter((_, index) => index !== itemIndex) })
                }
                aria-label={`項目${itemIndex + 1}を削除`}
              >
                <Trash2 size={15} aria-hidden="true" />
              </button>
            </div>
            {(item.children ?? []).map((child, childIndex) => (
              <div
                key={`${block.id}_item_${itemIndex}_child_${childIndex}`}
                className="blockEditor__listRow blockEditor__listRow--child"
              >
                <span aria-hidden="true">◦</span>
                <input
                  className="field__input field__input--xs"
                  value={child}
                  placeholder="ネスト項目"
                  aria-label={`項目${itemIndex + 1}のネスト${childIndex + 1}`}
                  onChange={(event) => updateChild(itemIndex, childIndex, event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Tab") {
                      event.preventDefault();
                      if (event.shiftKey) outdentChild(itemIndex, childIndex);
                    }
                  }}
                />
                <button
                  type="button"
                  className="blockEditor__iconButton"
                  onClick={() =>
                    onChange({
                      ...block,
                      items: block.items.map((entry, index) =>
                        index === itemIndex
                          ? {
                              ...entry,
                              children: entry.children?.filter((_, index) => index !== childIndex),
                            }
                          : entry,
                      ),
                    })
                  }
                  aria-label={`ネスト項目${childIndex + 1}を削除`}
                >
                  <Trash2 size={15} aria-hidden="true" />
                </button>
              </div>
            ))}
          </Fragment>
        ))}
      </div>
      <button
        type="button"
        className="btn btn--ghost btn--xs blockEditor__addItem"
        onClick={() => onChange({ ...block, items: [...block.items, { text: "" }] })}
      >
        ＋ 項目を追加
      </button>
      <p className="blockEditor__help">Tabで1段下げる／Shift+Tabで戻す</p>
    </div>
  );
}

export function BlockEditor({
  blocks,
  onChange,
  uploading,
  onImageUpload,
  photoUrls,
}: BlockEditorProps) {
  const [openInsertAt, setOpenInsertAt] = useState<number | null>(null);

  function patch(id: string, update: (block: ProfileBlock) => ProfileBlock) {
    onChange(blocks.map((block) => (block.id === id ? update(block) : block)));
  }

  function move(index: number, direction: -1 | 1) {
    const next = [...blocks];
    const destination = index + direction;
    if (destination < 0 || destination >= next.length) return;
    [next[index], next[destination]] = [next[destination], next[index]];
    onChange(next);
  }

  function insert(type: BlockType, position: number) {
    const next = [...blocks];
    next.splice(position, 0, emptyBlock(type));
    onChange(next);
    setOpenInsertAt(null);
  }

  return (
    <div className="blockEditor">
      {blocks.length === 0 ? (
        <p className="blockEditor__empty">まだブロックがありません。見出しや本文から追加できます。</p>
      ) : null}
      {blocks.map((block, index) => (
        <Fragment key={block.id}>
          <article className={`blockEditor__block blockEditor__block--${block.type}`}>
            <div className="blockEditor__toolbar">
              <span className="blockEditor__type">{BLOCK_TYPE_LABEL[block.type]}</span>
              <span className="blockEditor__spacer" />
              <button
                type="button"
                className="blockEditor__iconButton"
                onClick={() => move(index, -1)}
                disabled={index === 0}
                aria-label={`${BLOCK_TYPE_LABEL[block.type]}ブロックを上へ移動`}
                title="上へ"
              >
                <ArrowUp size={16} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="blockEditor__iconButton"
                onClick={() => move(index, 1)}
                disabled={index === blocks.length - 1}
                aria-label={`${BLOCK_TYPE_LABEL[block.type]}ブロックを下へ移動`}
                title="下へ"
              >
                <ArrowDown size={16} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="blockEditor__iconButton"
                onClick={() => {
                  const next = [...blocks];
                  next.splice(index + 1, 0, cloneBlock(block));
                  onChange(next);
                }}
                aria-label={`${BLOCK_TYPE_LABEL[block.type]}ブロックを複製`}
                title="複製"
              >
                <Copy size={16} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="blockEditor__iconButton blockEditor__iconButton--danger"
                onClick={() => onChange(blocks.filter((entry) => entry.id !== block.id))}
                aria-label={`${BLOCK_TYPE_LABEL[block.type]}ブロックを削除`}
                title="削除"
              >
                <Trash2 size={16} aria-hidden="true" />
              </button>
            </div>

            {block.type === "heading" ? (
              <div className="blockEditor__headingRow">
                <input
                  className="field__input blockEditor__heading"
                  placeholder="見出し"
                  value={block.text}
                  aria-label="見出し"
                  onChange={(event) =>
                    patch(block.id, (current) =>
                      current.type === "heading" ? { ...current, text: event.target.value } : current,
                    )
                  }
                />
                <div className="blockEditor__segments" role="group" aria-label="見出しの大きさ">
                  <button
                    type="button"
                    className={(block.level ?? 2) === 2 ? "is-selected" : ""}
                    aria-pressed={(block.level ?? 2) === 2}
                    onClick={() => patch(block.id, (current) => ({ ...current, level: 2 }))}
                  >
                    大
                  </button>
                  <button
                    type="button"
                    className={block.level === 3 ? "is-selected" : ""}
                    aria-pressed={block.level === 3}
                    onClick={() => patch(block.id, (current) => ({ ...current, level: 3 }))}
                  >
                    小
                  </button>
                </div>
              </div>
            ) : null}

            {block.type === "text" ? (
              <AutoGrowTextarea
                value={block.text}
                onChange={(text) =>
                  patch(block.id, (current) =>
                    current.type === "text" ? { ...current, text } : current,
                  )
                }
              />
            ) : null}

            {block.type === "list" ? (
              <ListEditor
                block={block}
                onChange={(next) => patch(block.id, () => next)}
              />
            ) : null}

            {block.type === "image" ? (
              <div className="blockEditor__images">
                {block.images.map((image, imageIndex) => (
                  <figure key={`${image.path}_${imageIndex}`} className="blockEditor__imageItem">
                    {photoUrls[image.path] ? (
                      <img src={photoUrls[image.path]} alt={image.caption ?? ""} />
                    ) : (
                      <div className="empdetail__photoLoading">…</div>
                    )}
                    <input
                      className="field__input field__input--xs"
                      placeholder="キャプション（任意）"
                      value={image.caption ?? ""}
                      onChange={(event) =>
                        patch(block.id, (current) =>
                          current.type === "image"
                            ? {
                                ...current,
                                images: current.images.map((entry, index) =>
                                  index === imageIndex
                                    ? { ...entry, caption: event.target.value || undefined }
                                    : entry,
                                ),
                              }
                            : current,
                        )
                      }
                    />
                    <button
                      type="button"
                      className="btn btn--ghost btn--xs"
                      onClick={() =>
                        patch(block.id, (current) =>
                          current.type === "image"
                            ? {
                                ...current,
                                images: current.images.filter((_, index) => index !== imageIndex),
                              }
                            : current,
                        )
                      }
                      aria-label={`画像${imageIndex + 1}を削除`}
                    >
                      画像を削除
                    </button>
                  </figure>
                ))}
                <label className="btn btn--ghost btn--xs blockEditor__upload">
                  {uploading ? "アップロード中…" : "＋ 画像を追加"}
                  <input
                    className="blockEditor__fileInput"
                    type="file"
                    accept="image/*"
                    disabled={uploading}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) onImageUpload(block.id, file);
                      event.target.value = "";
                    }}
                  />
                </label>
              </div>
            ) : null}

            {block.type === "link" ? (
              <div className="blockEditor__link">
                <input
                  className="field__input field__input--xs"
                  placeholder="URL（https://…）"
                  value={block.url}
                  onChange={(event) =>
                    patch(block.id, (current) =>
                      current.type === "link" ? { ...current, url: event.target.value } : current,
                    )
                  }
                />
                <input
                  className="field__input field__input--xs"
                  placeholder="タイトル（任意）"
                  value={block.title ?? ""}
                  onChange={(event) =>
                    patch(block.id, (current) =>
                      current.type === "link"
                        ? { ...current, title: event.target.value || undefined }
                        : current,
                    )
                  }
                />
                <input
                  className="field__input field__input--xs"
                  placeholder="説明（任意）"
                  value={block.description ?? ""}
                  onChange={(event) =>
                    patch(block.id, (current) =>
                      current.type === "link"
                        ? { ...current, description: event.target.value || undefined }
                        : current,
                    )
                  }
                />
              </div>
            ) : null}

            <LayoutPicker
              value={block.layout}
              onChange={(layout) => patch(block.id, (current) => ({ ...current, layout }))}
            />
          </article>

          {index < blocks.length - 1 ? (
            <InsertControl
              position={index + 1}
              open={openInsertAt === index + 1}
              onToggle={() => setOpenInsertAt(openInsertAt === index + 1 ? null : index + 1)}
              onInsert={insert}
            />
          ) : null}
        </Fragment>
      ))}

      <InsertControl
        position={blocks.length}
        persistent
        open={openInsertAt === blocks.length}
        onToggle={() => setOpenInsertAt(openInsertAt === blocks.length ? null : blocks.length)}
        onInsert={insert}
      />
    </div>
  );
}
