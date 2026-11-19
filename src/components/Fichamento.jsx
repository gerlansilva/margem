import { useEffect, useState } from 'react'
import { Icon } from './Icons'

const SUGGESTED = [
  { name: 'Pergunta de pesquisa', instruction: 'Qual pergunta o estudo busca responder?' },
  { name: 'Desenho do estudo', instruction: 'Tipo de estudo: ensaio, coorte, revisão sistemática, qualitativo…' },
  { name: 'Amostra', instruction: 'Tamanho e características da amostra (N, população, país).' },
  { name: 'Achados principais', instruction: 'Resultados principais, com números e tamanhos de efeito.' },
  { name: 'Limitações', instruction: 'Limitações declaradas pelos autores.' },
]

export function Fichamento({
  docs,
  columns,
  cells,
  onSaveColumns,
  onExtract,
  onExtractAll,
  onSource,
  onExport,
  busy,
}) {
  const [draft, setDraft] = useState(columns)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    setDraft(columns)
    setDirty(false)
  }, [columns])

  function update(index, field, value) {
    setDraft((prev) => prev.map((column, i) => (i === index ? { ...column, [field]: value } : column)))
    setDirty(true)
  }

  function add() {
    setDraft((prev) => [...prev, { id: '', name: '', instruction: '', type: 'text' }])
    setDirty(true)
  }

  function remove(index) {
    setDraft((prev) => prev.filter((_, i) => i !== index))
    setDirty(true)
  }

  function useSuggested() {
    setDraft(SUGGESTED.map((item) => ({ ...item, id: '', type: 'text' })))
    setDirty(true)
  }

  const ready = docs.filter((doc) => doc.page_count > 0)

  return (
    <div className="table-view">
      <div className="table-head">
        <div>
          <h2>Quadro de fichamento</h2>
          <p>
            Cada coluna é uma instrução para a IA. Toda célula preenchida guarda o trecho literal e a página de
            onde saiu.
          </p>
        </div>
        <div className="table-actions">
          <button className="btn ghost" onClick={useSuggested}>
            Colunas sugeridas
          </button>
          <button className="btn ghost" onClick={onExport} disabled={!columns.length}>
            Exportar CSV
          </button>
          <button className="btn primary" onClick={onExtractAll} disabled={!columns.length || !!busy}>
            Extrair todos
          </button>
        </div>
      </div>

      <details className="columns-box" open={columns.length === 0}>
        <summary>
          Colunas do fichamento <span className="count">{draft.length}</span>
        </summary>
        <div className="columns-list">
          {draft.map((column, index) => (
            <div className="column-row" key={index}>
              <input
                className="col-name"
                placeholder="Nome da coluna"
                value={column.name}
                onChange={(event) => update(index, 'name', event.target.value)}
              />
              <input
                className="col-instruction"
                placeholder="O que deve ser extraído (instrução para a IA)"
                value={column.instruction}
                onChange={(event) => update(index, 'instruction', event.target.value)}
              />
              <button className="icon-btn" title="Remover coluna" onClick={() => remove(index)}>
                {Icon.trash({ className: 'ico' })}
              </button>
            </div>
          ))}
          {draft.length === 0 && <p className="muted">Nenhuma coluna. Adicione ou use as sugeridas.</p>}
        </div>
        <div className="columns-foot">
          <button className="btn ghost" onClick={add}>
            {Icon.plus({ className: 'ico' })} Adicionar coluna
          </button>
          <button className="btn primary" disabled={!dirty} onClick={() => onSaveColumns(draft)}>
            Salvar colunas
          </button>
        </div>
      </details>

      {columns.length === 0 ? (
        <div className="empty small">
          <p>Defina as colunas acima para começar o fichamento.</p>
        </div>
      ) : ready.length === 0 ? (
        <div className="empty small">
          <p>Adicione e processe um PDF para preencher o quadro.</p>
        </div>
      ) : (
        <div className="table-scroll">
          <table className="fichamento">
            <thead>
              <tr>
                <th className="sticky">Documento</th>
                {columns.map((column) => (
                  <th key={column.id} title={column.instruction}>
                    {column.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ready.map((doc) => {
                const extracting = busy?.docId === doc.id
                return (
                  <tr key={doc.id}>
                    <td className="sticky doc-cell">
                      <span className="doc-cell-name" title={doc.name}>
                        {doc.name}
                      </span>
                      <span className="doc-cell-pages">{doc.page_count} p.</span>
                      <button
                        className="btn tiny row-extract"
                        disabled={!!busy}
                        onClick={() => onExtract(doc)}
                      >
                        {extracting ? 'extraindo…' : 'Extrair'}
                      </button>
                    </td>
                    {columns.map((column) => {
                      const cell = cells.find(
                        (item) => item.doc_id === doc.id && item.column_id === column.id,
                      )
                      const filled = cell?.value && cell?.quote
                      return (
                        <td key={column.id}>
                          {filled ? (
                            <button
                              className="cell filled"
                              onClick={() =>
                                onSource({
                                  doc,
                                  page: cell.page,
                                  quote: cell.quote,
                                  evidenceId: cell.evidence?.[0],
                                })
                              }
                              title="Abrir o trecho no PDF"
                            >
                              <span className="cell-value">{cell.value}</span>
                              {cell.page && <span className="cell-page">p.{cell.page}</span>}
                            </button>
                          ) : (
                            <span className={`cell-empty ${extracting ? 'working' : ''}`}>
                              {extracting ? 'extraindo…' : cell?.status === 'not_found' ? 'não encontrado' : '—'}
                            </span>
                          )}
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
