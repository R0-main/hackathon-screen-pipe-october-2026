import { redirect } from "next/navigation"

// Le fil des agents vit désormais sur le cerveau : les anciens liens vers /activite y mènent.
export default function Page() {
  redirect("/dashboard")
}
