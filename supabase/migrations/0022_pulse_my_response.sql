-- ─────────────────────────────────────────────────────────────────────
-- 0022_pulse_my_response
--
-- #4 パルスサーベイ スライス2（回答画面 #/survey）用の読み取り RPC。
-- 回答画面は「対象社員か？」「このサイクルに既回答か？（プレフィル）」を
-- 必要とする。employees.email ↔ auth.email() の本人特定はサーバ専任
-- （0021 pulse_current_employee_number）なので、クライアントに自分の
-- employee_number を晒さずに済むよう 1 本の SECURITY DEFINER RPC で返す。
--
-- pulse_my_response(p_cycle_id):
--   • 対象社員でない（employees.email 未一致 / 退職）→ null
--   • 対象社員だが未回答 → {employee_number, response:null, answers:[]}
--   • 既回答 → {employee_number, response:{...}, answers:[{question_id,score,value_text}]}
--
-- Idempotent. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────

begin;

create or replace function public.pulse_my_response(p_cycle_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_emp text := public.pulse_current_employee_number();
  v_resp public.pulse_responses;
  v_answers jsonb;
begin
  if v_emp is null then
    return null;                              -- サーベイ対象社員ではない
  end if;

  select * into v_resp
  from public.pulse_responses
  where cycle_id = p_cycle_id
    and employee_number = v_emp;

  if not found then
    return jsonb_build_object(
      'employee_number', v_emp,
      'response', null,
      'answers', '[]'::jsonb
    );
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'question_id', a.question_id,
           'score', a.score,
           'value_text', a.value_text)), '[]'::jsonb)
    into v_answers
  from public.pulse_answers a
  where a.response_id = v_resp.id;

  return jsonb_build_object(
    'employee_number', v_emp,
    'response', to_jsonb(v_resp),
    'answers', v_answers
  );
end;
$$;

revoke all on function public.pulse_my_response(uuid) from public, anon;
grant execute on function public.pulse_my_response(uuid) to authenticated, service_role;

commit;
