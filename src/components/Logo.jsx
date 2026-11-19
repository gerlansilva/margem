/**
 * Marca do Margem: o "m" manuscrito fecha numa interrogação e o ponto é a
 * anotação à margem. As três camadas (fundo, "m", ponto) são máscaras
 * pintadas com variáveis de cor (fundo = cor de acento), sem trocar de imagem.
 */
export function Logo({ size = 30 }) {
  return (
    <span className="logo" style={{ width: size, height: size }} role="img" aria-label="Margem">
      <i className="logo-m" />
      <i className="logo-dot" />
    </span>
  )
}
