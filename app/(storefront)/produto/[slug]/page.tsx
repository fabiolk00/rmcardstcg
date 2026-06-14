export default async function ProdutoPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return (
    <section>
      <h1>Produto</h1>
      <p>Página de produto (placeholder — conteúdo real no slice F4+).</p>
      <p>slug: {slug}</p>
    </section>
  );
}
