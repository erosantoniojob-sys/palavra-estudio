# Palavra — Estúdio de gravação e transcrição

Aplicativo web para gravar **pregações, aulas e palestras** com **transcrição em tempo real**.
Também importa arquivos de áudio e os transcreve no próprio aparelho, sem servidor ou chave de API.

## O que ele faz

- Grava o áudio pelo microfone e transcreve ao vivo, em português (ou inglês/espanhol)
- Importa MP3, M4A, WAV, OGG, WebM e FLAC de até 45 minutos e gera a transcrição localmente
- Baixa o modelo Whisper na primeira importação; o arquivo de áudio não é enviado para um serviço externo
- Separa o texto em parágrafos automaticamente quando o pregador faz uma pausa
- Marca o tempo de cada parágrafo; depois de gravar, clicar no tempo toca aquele trecho do áudio
- Pausar / retomar / encerrar; botão (ou tecla **N**) para forçar novo parágrafo
- Texto editável: clique em qualquer trecho para corrigir
- Exporta em **Word (.doc)**, **.txt**, **Markdown**, **legendas .srt** e o **áudio** da gravação
- **Arquivo** com todas as sessões, salvas no próprio navegador (IndexedDB)
- Mantém a tela acesa durante a gravação e avisa antes de fechar a aba

## Limitações importantes

- **Navegador:** a transcrição ao vivo usa a Web Speech API e funciona melhor no **Google Chrome** e no **Microsoft Edge**. A transcrição de arquivos usa Transformers.js e requer um navegador moderno.
- **Internet:** a primeira transcrição de arquivo baixa o modelo Whisper do Hugging Face. Depois, o modelo fica em cache no navegador. A transcrição ao vivo no Chrome é processada pelos servidores do Google.
- **Desempenho:** a transcrição de arquivos é feita no aparelho; o tempo depende da duração do áudio e da capacidade do dispositivo.
- **Aba aberta:** mantenha a aba em primeiro plano durante a gravação. No celular, se a tela bloquear ou você trocar de app, a transcrição pode parar.
- **Celular Android:** alguns aparelhos não deixam gravar o áudio e transcrever ao mesmo tempo (o microfone fica “ocupado”). No computador isso não acontece.
- **Dados locais:** as sessões ficam salvas só naquele navegador/aparelho. Exporte o que for importante.
- **Qualidade:** a transcrição é boa para rascunho; nomes próprios e termos bíblicos/teológicos às vezes precisam de correção manual.

## Publicar no GitHub

1. Crie um repositório novo em <https://github.com/new> (ex.: `palavra-estudio`).
2. Na pasta do projeto, rode:

```bash
git init
git add .
git commit -m "Primeira versão do Palavra"
git branch -M main
git remote add origin https://github.com/SEU-USUARIO/palavra-estudio.git
git push -u origin main
```

> Sem usar o terminal: na página do repositório vazio, clique em **“uploading an existing file”** e arraste todos os arquivos da pasta.

## Publicar na Vercel

1. Entre em <https://vercel.com> com sua conta do GitHub.
2. Clique em **Add New → Project** e escolha o repositório `palavra-estudio`.
3. Em **Framework Preset**, deixe **Other** (é um site estático; não há build).
4. Clique em **Deploy**. Em ~30 segundos você recebe um endereço como `palavra-estudio.vercel.app`.

Cada `git push` para o GitHub atualiza o site automaticamente.

> O microfone só funciona em **HTTPS** — a Vercel já fornece isso.

## Testar no computador antes de publicar

```bash
npx serve .
# ou
python3 -m http.server 8000
```

Abra `http://localhost:8000` no Chrome.

## Instalar no celular

Abra o site no Chrome do Android → menu ⋮ → **Adicionar à tela inicial**.

## Estrutura

```
index.html            página
style.css             visual
app.js                gravação, transcrição, arquivo e exportação
manifest.webmanifest  instalação como app
icon.svg              ícone
vercel.json           configurações de cabeçalho para a Vercel
```

## Próximos passos possíveis

- **Transcrição profissional** (mais precisa, funciona em qualquer navegador): integrar um serviço como Deepgram, AssemblyAI ou OpenAI Whisper por meio de uma função na Vercel. Exige chave de API e tem custo por minuto.
- Vocabulário personalizado (nomes de livros bíblicos, termos teológicos) para corrigir automaticamente.
- Sincronização na nuvem entre aparelhos.
