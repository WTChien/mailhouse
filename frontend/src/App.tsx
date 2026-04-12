import TempMail from './components/TempMail';

export default function App() {
  return (
    <main className="simple-shell">
      <header className="simple-header">
        <div>
          <p className="eyebrow">gradaide.xyz</p>
          <h1>Mailhouse 信箱中心</h1>
          <p className="subtitle">降低誤觸、快速分類、集中管理驗證信箱</p>
        </div>
      </header>

      <TempMail />
    </main>
  );
}
