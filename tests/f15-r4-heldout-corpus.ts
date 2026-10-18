/**
 * Audit F15 re-audit round 3 (FAIL 8/10), ruling R4-6: a second held-out false-positive corpus.
 *
 * Written on 2026-10-17 BEFORE any round-4 change to the mask or the residual detector, and before reading the
 * re-auditor's round-3 fresh corpus (r3-fresh-fp.json), which is also used only as held-out prose. It is committed on
 * its own and is NOT edited after the round-4 measurement. Lines that fail are reported; only after the measurement may
 * they be copied into a regression test (the copy lives in the test, never here).
 *
 * Every line is ordinary Pakistani legal prose that names no person, address, phone, account or identity number, in
 * genres the earlier corpora did not cover much: affidavits, powers of attorney, rent and sale deeds, legal notices,
 * family-court orders, revenue entries, police diaries, medical reports, service and banking matters, order sheets.
 */

export const HELDOUT_CORPUS_R4: ReadonlyArray<readonly [genre: string, text: string]> = [
  // English: affidavits and powers of attorney
  ["affidavit", "I, the deponent, do hereby solemnly affirm and declare on oath as under."],
  ["affidavit", "That the contents of the accompanying application are true and correct to the best of my knowledge and belief."],
  ["affidavit", "That nothing has been concealed or misstated therein."],
  ["affidavit", "Verified on oath at the place and on the date mentioned below."],
  ["attorney", "The executant appoints the attorney to appear before any court, tribunal or authority on his behalf."],
  ["attorney", "The attorney shall have the power to sign, verify and file pleadings, applications and affidavits."],
  ["attorney", "This general power of attorney shall remain in force until revoked in writing."],
  // English: rent and sale deeds
  ["deed", "The tenant shall pay the monthly rent in advance by the tenth day of each calendar month."],
  ["deed", "The tenancy shall be for a period of eleven months, renewable with the consent of both parties."],
  ["deed", "The security deposit equal to three months' rent shall be refunded on vacation of the premises."],
  ["deed", "The vendor has received the entire sale consideration and has no further claim against the vendee."],
  ["deed", "Possession of the property has been delivered to the vendee on the execution of this deed."],
  ["deed", "The property is free from all encumbrances, charges, liens and mortgages."],
  // English: legal notices
  ["notice", "Take notice that my client intends to initiate legal proceedings against you without further notice."],
  ["notice", "You are called upon to pay the outstanding amount within fifteen days of the receipt of this notice."],
  ["notice", "A copy of this notice has been retained in my office for record and further action."],
  ["notice", "The cheque presented by my client was dishonoured on presentation for want of sufficient funds."],
  // English: family court
  ["family", "The suit for dissolution of marriage on the basis of khula is decreed subject to the return of the dower."],
  ["family", "Reconciliation efforts at the pre-trial stage have failed."],
  ["family", "The defendant is directed to pay maintenance to the minors at the rate fixed by the court."],
  ["family", "The custody of the minor shall remain with the mother till the age of seven years."],
  ["family", "The father shall be entitled to meet the minor on alternate Sundays at the court premises."],
  ["family", "The daughter of the parties is a student and is residing with her mother."],
  ["family", "The son of the parties has attained the age of majority and is not entitled to maintenance."],
  // English: revenue
  ["revenue", "The mutation was sanctioned by the Revenue Officer after recording the statements of the parties."],
  ["revenue", "The entries in the record of rights carry a presumption of truth unless rebutted."],
  ["revenue", "The partition proceedings are pending before the Assistant Collector First Grade."],
  ["revenue", "The demarcation report of the Tehsildar was objected to by both sides."],
  // English: police diaries and medical
  ["police", "The Investigating Officer recorded the statements of the witnesses under section 161 Cr.P.C. on the same day."],
  ["police", "The accused was produced before the Magistrate for physical remand within twenty-four hours."],
  ["police", "Raids were conducted to arrest the absconding co-accused but they could not be traced."],
  ["police", "The case property was sent to the Forensic Science Agency for analysis."],
  ["medical", "The injured was examined in the emergency department and the injuries were declared simple in nature."],
  ["medical", "Probable time between injury and death was within half an hour."],
  ["medical", "The doctor deposed that the injuries could not be self-inflicted."],
  // English: service and banking
  ["service", "The appellant was dismissed from service after a regular inquiry."],
  ["service", "The departmental appeal was not decided within the statutory period of ninety days."],
  ["service", "The seniority list was challenged as being contrary to the rules."],
  ["banking", "The customer defaulted in the repayment of the finance facility and the bank filed a recovery suit."],
  ["banking", "The statement of account was duly certified under the Bankers' Books Evidence Act."],
  ["banking", "The mortgaged property was put to auction after notice to the judgment debtor."],
  // English: order sheets and judgments
  ["order", "Counsel for the respondent seeks time to file the reply; granted as a last opportunity."],
  ["order", "Learned counsel for the appellant is not present; adjourned."],
  ["order", "Notice be issued to the respondents for the next date of hearing."],
  ["order", "The accused present on bail; the prosecution witnesses are absent."],
  ["judgment", "The prosecution has failed to prove its case beyond reasonable doubt."],
  ["judgment", "The wife of the deceased was cited as a witness but was given up by the prosecution."],
  ["judgment", "The son of the complainant was not present at the time of the occurrence."],
  ["judgment", "The brother of the accused stood surety for him."],
  ["judgment", "The widow and the minor children of the deceased are entitled to compensation."],
  // Urdu: FIR and police
  ["urdu-fir", "مدعی نے تھانہ میں تحریری درخواست دی جس پر مقدمہ درج کیا گیا۔"],
  ["urdu-fir", "وقوعہ کی اطلاع تاخیر سے دی گئی جس کی کوئی وضاحت موجود نہیں۔"],
  ["urdu-police", "تفتیشی افسر نے گواہان کے بیانات زیر دفعہ ۱۶۱ ض ف قلمبند کیے۔"],
  ["urdu-police", "ملزم کو جسمانی ریمانڈ کے لیے علاقہ مجسٹریٹ کے روبرو پیش کیا گیا۔"],
  ["urdu-police", "مفرور ملزمان کی گرفتاری کے لیے چھاپے مارے گئے مگر وہ دستیاب نہ ہوئے۔"],
  ["urdu-police", "مال مقدمہ کو سربمہر کر کے مال خانہ میں جمع کرایا گیا۔"],
  // Urdu: plaint and written statement
  ["urdu-plaint", "یہ کہ مدعی متدعویہ جائیداد کا مالک و قابض ہے۔"],
  ["urdu-plaint", "یہ کہ مدعا علیہان نے بلا جواز مدعی کے قبضہ میں مداخلت کی کوشش کی۔"],
  ["urdu-plaint", "یہ کہ دعویٰ ہذا میعاد کے اندر دائر کیا گیا ہے۔"],
  ["urdu-ws", "یہ کہ دعویٰ قابل سماعت نہ ہے اور خارج کیے جانے کے قابل ہے۔"],
  ["urdu-ws", "یہ کہ مدعی کو دعویٰ دائر کرنے کا کوئی حق حاصل نہیں۔"],
  // Urdu: affidavit and attorney
  ["urdu-affidavit", "میں حلفاً بیان کرتا ہوں کہ درخواست کے مندرجات درست ہیں۔"],
  ["urdu-affidavit", "یہ کہ بیان حلفی میں کوئی بات پوشیدہ نہیں رکھی گئی۔"],
  ["urdu-attorney", "مختار کو اختیار ہوگا کہ وہ میری طرف سے عدالت میں پیش ہو۔"],
  ["urdu-attorney", "مختار نامہ عام تحریری منسوخی تک نافذ العمل رہے گا۔"],
  // Urdu: deeds
  ["urdu-deed", "کرایہ دار ہر ماہ کی دس تاریخ تک پیشگی کرایہ ادا کرے گا۔"],
  ["urdu-deed", "کرایہ نامہ کی مدت گیارہ ماہ ہوگی جو فریقین کی رضامندی سے بڑھائی جا سکے گی۔"],
  ["urdu-deed", "بائع نے مکمل زر ثمن وصول پا لیا ہے اور اب اس کا کوئی مطالبہ باقی نہیں۔"],
  ["urdu-deed", "جائیداد ہر قسم کے بار، رہن اور دعویٰ سے پاک ہے۔"],
  // Urdu: notices
  ["urdu-notice", "آپ کو مطلع کیا جاتا ہے کہ پندرہ یوم کے اندر واجب الادا رقم ادا کریں۔"],
  ["urdu-notice", "بصورت دیگر آپ کے خلاف قانونی کارروائی عمل میں لائی جائے گی۔"],
  // Urdu: family court
  ["urdu-family", "خلع کی بنیاد پر تنسیخ نکاح کی ڈگری حق مہر کی واپسی سے مشروط کی جاتی ہے۔"],
  ["urdu-family", "مصالحت کی کوششیں ناکام ہو گئیں۔"],
  ["urdu-family", "مدعا علیہ نابالغان کو ماہانہ خرچہ ادا کرے گا۔"],
  ["urdu-family", "نابالغ کی حضانت سات سال کی عمر تک والدہ کے پاس رہے گی۔"],
  ["urdu-family", "والد ہر دوسرے اتوار کو عدالت کے احاطہ میں نابالغ سے ملاقات کر سکے گا۔"],
  ["urdu-family", "فریقین کی دختر زیر تعلیم ہے اور اپنی والدہ کے ساتھ رہتی ہے۔"],
  ["urdu-family", "فریقین کا پسر بالغ ہو چکا ہے اس لیے خرچہ کا حقدار نہیں۔"],
  ["urdu-family", "نکاح نامہ کے مطابق حق مہر موجل مقرر کیا گیا تھا۔"],
  // Urdu: inheritance and revenue
  ["urdu-revenue", "انتقال وراثت ریونیو افسر نے فریقین کے بیانات قلمبند کرنے کے بعد منظور کیا۔"],
  ["urdu-revenue", "ریکارڈ مال کے اندراجات درست تصور کیے جاتے ہیں جب تک ان کی تردید نہ ہو۔"],
  ["urdu-revenue", "تقسیم کی کارروائی اسسٹنٹ کلکٹر درجہ اول کے روبرو زیر سماعت ہے۔"],
  ["urdu-revenue", "تحصیلدار کی حد براری رپورٹ پر دونوں فریقین نے اعتراض کیا۔"],
  ["urdu-revenue", "متوفی کے ترکہ میں بیوہ کو آٹھواں حصہ ملے گا۔"],
  // Urdu: medical
  ["urdu-medical", "زخمی کا معائنہ ایمرجنسی میں کیا گیا اور زخم معمولی قرار دیے گئے۔"],
  ["urdu-medical", "ڈاکٹر نے بیان کیا کہ زخم خود ساختہ نہیں ہو سکتے۔"],
  // Urdu: service and banking
  ["urdu-service", "اپیل کنندہ کو باقاعدہ انکوائری کے بعد ملازمت سے برخاست کیا گیا۔"],
  ["urdu-service", "محکمانہ اپیل کا فیصلہ مقررہ مدت میں نہیں کیا گیا۔"],
  ["urdu-banking", "صارف نے قرض کی ادائیگی میں نادہندگی کی اور بینک نے وصولی کا دعویٰ دائر کیا۔"],
  ["urdu-banking", "رہن شدہ جائیداد کو مقروض کو نوٹس دینے کے بعد نیلام کیا گیا۔"],
  // Urdu: order sheets and judgments
  ["urdu-order", "مسئول علیہ کے وکیل نے جواب داخل کرنے کے لیے مہلت طلب کی جو آخری موقع کے طور پر دی گئی۔"],
  ["urdu-order", "اپیل کنندہ کے وکیل حاضر نہیں، سماعت ملتوی کی جاتی ہے۔"],
  ["urdu-order", "ملزم ضمانت پر حاضر ہے، گواہان استغاثہ غیر حاضر ہیں۔"],
  ["urdu-judgment", "استغاثہ اپنا مقدمہ شک سے بالاتر ثابت کرنے میں ناکام رہا۔"],
  ["urdu-judgment", "متوفی کی زوجہ کو بطور گواہ نامزد کیا گیا مگر استغاثہ نے اسے ترک کر دیا۔"],
  ["urdu-judgment", "مدعی کا پسر وقوعہ کے وقت موقع پر موجود نہیں تھا۔"],
  ["urdu-judgment", "ملزم کے بھائی نے اس کی ضمانت دی۔"],
  ["urdu-judgment", "متوفی کی بیوہ اور نابالغ بچے معاوضہ کے حقدار ہیں۔"],
  ["urdu-judgment", "مقتول کا ولد بطور گواہ پیش نہیں ہوا۔"],
]
