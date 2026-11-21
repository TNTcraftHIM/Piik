import { useState, type FormEvent } from "react";
import { JoinCodeForm, JoinPasswordForm } from "../components/living/JoinRoomForms";

export function GuideJoinControls({ password }: { password: boolean }) {
  const [code, setCode] = useState("9527");
  const [passwordDraft, setPasswordDraft] = useState("");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
  }

  return (
    <div data-guide-capture data-guide-ready style={{ width: "fit-content", maxWidth: "100%", padding: 16 }}>
      {password
        ? <JoinPasswordForm value={passwordDraft} onChange={setPasswordDraft} onSubmit={submit} />
        : <JoinCodeForm value={code} onChange={setCode} onSubmit={submit} />}
    </div>
  );
}
