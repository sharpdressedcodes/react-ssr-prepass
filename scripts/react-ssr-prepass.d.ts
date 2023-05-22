declare module 'react-ssr-prepass' {
  type Visitor = (
    // https://github.com/FormidableLabs/react-ssr-prepass/pull/87
    // element: React.ElementType<any>,
    element: React.ReactElement<any>,
    instance?: React.Component<any, any>
  ) => void | Promise<any>

  function ssrPrepass(node: React.ReactNode, visitor?: Visitor): Promise<void>

  export = ssrPrepass
}
