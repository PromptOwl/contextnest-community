declare module "markdown-it-container" {
  interface ContainerOpts {
    marker?: string;
    validate?: (params: string) => boolean;
    render?: (tokens: any[], idx: number, ...rest: any[]) => string;
  }
  const container: (md: any, name: string, options?: ContainerOpts) => unknown;
  export default container;
}
