import logo from '../assets/margem.png'

/**
 * Marca do Margem: o "m" manuscrito fecha numa interrogação e o ponto em
 * damasco é a anotação à margem.
 */
export function Logo({ size = 30 }) {
  return (
    <img
      className="logo"
      src={logo}
      width={size}
      height={size}
      alt="Margem"
      draggable={false}
    />
  )
}
