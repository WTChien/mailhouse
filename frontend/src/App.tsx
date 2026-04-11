import TempMail from './components/TempMail';

export default function App() {
  return (
    <main className="simple-shell">
      <header className="simple-header">
        <div>
          <p className="eyebrow">gradaide.xyz</p>
          <h1>Mailhouse 信箱中心</h1>
        </div>
      </header>

      <TempMail />
    </main>
  );
}
