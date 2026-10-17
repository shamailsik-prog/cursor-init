/**
 * Audit F15 re-audit round 4 (FAIL 7/10), ruling R5-5: a third held-out false-positive corpus.
 *
 * Written on 2026-10-17 BEFORE any round-5 change to the mask or the residual detector, and before reading the
 * re-auditor's round-4 adversarial lines (r4-attack.json). It is committed on its own and is NOT edited after the
 * round-5 measurement. Lines that fail are reported; only after the measurement may they be copied into a regression
 * test (the copy lives in the test, never here).
 *
 * Every line is ordinary Pakistani legal prose that names no person, address, phone, account or identity number, in
 * genres the earlier corpora covered little: tax and customs, company and banking matters, consumer, labour and
 * election cases, accountability and anti-terrorism courts, rent, family and succession, constitutional and service
 * matters, police diaries, revenue records, cheques, defamation, cyber crime and procurement. Some lines use the words
 * round 5 keys on (kinship words before a role or an institution, "hails from", "belongs to", "residing", مقیم,
 * رہائش پذیر, سکونت پذیر) the way legal prose uses them without naming anyone.
 */

export const HELDOUT_CORPUS_R5: ReadonlyArray<readonly [genre: string, text: string]> = [
  // English: tax and customs
  ["tax", "The assessing officer made an addition to the declared income without confronting the taxpayer with the material relied upon."],
  ["tax", "The show cause notice was issued after the expiry of the period of limitation prescribed under the Ordinance."],
  ["customs", "The goods were released on furnishing a bank guarantee for the differential amount of duty and taxes."],
  ["tax", "The Commissioner Inland Revenue (Appeals) remanded the matter for a fresh assessment."],
  // English: company and banking
  ["company", "The company failed to hold its annual general meeting within the time allowed by the Act."],
  ["company", "The directors were jointly and severally liable for the default in filing the annual return."],
  ["company", "The winding up petition was admitted and the official liquidator was appointed."],
  ["banking", "The banking company filed a suit for recovery against the customer and the guarantors under the Financial Institutions (Recovery of Finances) Ordinance."],
  ["banking", "The leave to defend application raised no substantial question of law or fact."],
  ["banking", "The mortgaged property was put to auction after due publication in two newspapers."],
  // English: consumer, labour and election
  ["consumer", "The consumer court directed the manufacturer to replace the defective refrigerator or refund its price."],
  ["labour", "The workman was dismissed from service without a charge sheet or an inquiry."],
  ["labour", "The Labour Court reinstated the employee with back benefits from the date of termination."],
  ["election", "The returning officer rejected the nomination papers on the ground of a defaulted utility bill."],
  ["election", "The election petition was dismissed for want of a proper verification on oath."],
  // English: accountability and anti-terrorism
  ["nab", "The reference alleges that the accused accumulated assets beyond his known sources of income."],
  ["nab", "The accused was granted bail as the investigation had been completed and he was no longer required."],
  ["atc", "The Anti-Terrorism Court held that the occurrence lacked the design or purpose to create terror in society."],
  // English: rent, family and succession
  ["rent", "The Rent Controller ordered the tenant to deposit the arrears of rent within thirty days."],
  ["rent", "The landlord sought ejectment on the ground of personal bona fide need for his son's business."],
  ["rent", "The tenant has been residing in the premises for over twenty years."],
  ["family", "The wife sought dissolution of marriage by way of khula and offered to return the dower."],
  ["family", "The minor shall remain in the custody of the mother until he attains the age of seven years."],
  ["family", "The father shall pay maintenance for the minor at the rate fixed by the Family Court, with a ten percent annual increase."],
  ["succession", "The daughter of the deceased was held entitled to her share in the inheritance."],
  ["succession", "The succession certificate was issued in respect of the bank accounts and the pension of the deceased."],
  ["succession", "The legal heirs of the deceased filed a joint application for the transfer of the vehicle."],
  // English: constitutional and service
  ["constitutional", "The petitioner invoked the constitutional jurisdiction of this Court against the refusal to issue a domicile certificate."],
  ["constitutional", "The writ petition is not maintainable as an adequate alternate remedy is available under the statute."],
  ["service", "The civil servant was retired from service under the Efficiency and Discipline Rules without a personal hearing."],
  ["service", "The appellant, a son of a deceased civil servant, sought appointment under the deceased employees' quota."],
  ["service", "The departmental promotion committee deferred the case for want of the performance evaluation reports."],
  ["service", "The appellant is the widow of a former employee of the Pakistan Railways."],
  // English: police and medical
  ["police", "The investigating officer recorded the statements of the witnesses under section 161 of the Code of Criminal Procedure."],
  ["police", "The recovered pistol was sent to the Forensic Science Agency, whose report is positive."],
  ["police", "The complainant is the brother of the deceased and an interested witness."],
  ["police", "The accused remained absconder for two years and was declared a proclaimed offender."],
  ["medical", "The medico-legal officer observed six firearm injuries on the body of the deceased."],
  ["police", "The son of the late landlord of the village appeared as a witness for the defence."],
  // English: cheques, defamation, cyber crime, procurement and other matters
  ["cheque", "The cheque was dishonoured on presentation for want of sufficient funds in the account."],
  ["defamation", "The defamatory statement was published in a daily newspaper and repeated on a television programme."],
  ["cyber", "The complaint under the Prevention of Electronic Crimes Act was forwarded to the cyber crime wing."],
  ["procurement", "The procuring agency awarded the contract to the lowest evaluated bidder after technical evaluation."],
  ["arbitration", "The arbitrator's award was made a rule of the court as no objections were filed within time."],
  ["civil", "The plaintiff hails from a family of agriculturists and has no other source of income."],
  ["criminal", "The respondent belongs to the same caste and was known to the complainant before the occurrence."],
  ["criminal", "The deceased was originally from a village in the same district."],
  ["civil", "The documents were sent care of the counsel for the respondent."],
  ["order", "Notice was issued to the respondents for a date to be fixed by the office."],
  ["order", "The petition stands disposed of in the above terms."],
  // Urdu: police diaries and medical reports
  ["urdu-police", "تفتیشی افسر نے موقع کا نقشہ تیار کر کے مثل کے ساتھ لف کیا۔"],
  ["urdu-police", "برآمد شدہ پستول کو سربمہر کر کے مال خانہ میں جمع کرایا گیا۔"],
  ["urdu-police", "ملزم وقوعہ کے روز سے روپوش ہے اور اس کے وارنٹ گرفتاری جاری کیے گئے۔"],
  ["urdu-police", "مدعی مقدمہ نے بیان دیا کہ اس کی کسی سے کوئی دشمنی نہیں ہے۔"],
  ["urdu-medical", "زخمی کو طبی معائنہ کے لیے سرکاری ہسپتال بھیجا گیا۔"],
  ["urdu-medical", "پوسٹ مارٹم رپورٹ کے مطابق موت آتشیں اسلحہ کے زخموں سے واقع ہوئی۔"],
  ["urdu-police", "ملزم کے خلاف اسی تھانہ میں پہلے بھی مقدمات درج ہیں۔"],
  ["urdu-police", "ملزم عرصہ دراز سے اسی علاقہ میں رہائش پذیر ہے۔"],
  // Urdu: revenue records
  ["urdu-revenue", "انتقال اراضی محکمہ مال کے ریکارڈ میں درج کیا گیا۔"],
  ["urdu-revenue", "گرداوری کے اندراج سے ظاہر ہے کہ زمین مدعی کے قبضہ میں ہے۔"],
  ["urdu-revenue", "پٹواری حلقہ نے فرد ملکیت جاری کرنے سے انکار کر دیا۔"],
  ["urdu-revenue", "تقسیم کی کارروائی تمام شرکاء کو نوٹس دیے بغیر مکمل کی گئی۔"],
  // Urdu: family and succession
  ["urdu-family", "دعویٰ تنسیخ نکاح بوجہ خلع ڈگری کیا جاتا ہے۔"],
  ["urdu-family", "نابالغ کی تحویل والدہ کے پاس رہے گی اور والد کو ملاقات کا حق حاصل ہوگا۔"],
  ["urdu-family", "مدعا علیہ کو ہدایت کی جاتی ہے کہ وہ نان و نفقہ کی بقایا رقم ادا کرے۔"],
  ["urdu-family", "حق مہر کی ادائیگی کا کوئی ثبوت پیش نہیں کیا گیا۔"],
  ["urdu-family", "مدعیہ اپنے والدین کے ہمراہ مقیم ہے۔"],
  ["urdu-succession", "متوفی کے قانونی ورثاء میں بیوہ، دو بیٹے اور تین بیٹیاں شامل ہیں۔"],
  ["urdu-succession", "متوفیہ کی دختر نے وراثتی سرٹیفکیٹ کے لیے درخواست دائر کی۔"],
  ["urdu-succession", "سائل کا والد سرکاری ملازم تھا اور دوران ملازمت فوت ہوا۔"],
  ["urdu-succession", "متوفی کی زوجہ دوم نے بھی ترکہ میں حصہ کا دعویٰ کیا۔"],
  ["urdu-succession", "ولدیت کے خانے میں اندراج غلط ہونے کی وجہ سے درستگی کی درخواست دی گئی۔"],
  // Urdu: residence words without an address
  ["urdu-civil", "درخواست گزار بیرون ملک مقیم ہے اور اس نے مختار نامہ کے ذریعے مقدمہ دائر کیا۔"],
  ["urdu-civil", "مدعا علیہ عرصہ پانچ سال سے کراچی میں سکونت پذیر ہے۔"],
  ["urdu-civil", "گواہ نے بتایا کہ وہ وقوعہ کے وقت شہر سے باہر تھا۔"],
  ["urdu-civil", "مدعی کا تعلق ایک زمیندار گھرانے سے ہے۔"],
  ["urdu-criminal", "ملزمان کا تعلق ایک ہی برادری سے ہے اور وہ ایک دوسرے کو جانتے تھے۔"],
  // Urdu: orders and judgments
  ["urdu-order", "عدالت نے فریقین کو باہمی رضامندی سے تنازعہ حل کرنے کا موقع دیا۔"],
  ["urdu-order", "مقدمہ ہذا میں استغاثہ کی شہادت مکمل ہو چکی ہے۔"],
  ["urdu-order", "ملزم کا بیان زیر دفعہ 342 ضابطہ فوجداری قلمبند کیا گیا۔"],
  ["urdu-order", "فریقین کے وکلاء کے دلائل سنے گئے اور ریکارڈ کا بغور جائزہ لیا گیا۔"],
  ["urdu-judgment", "اپیل کنندہ کو شک کا فائدہ دیتے ہوئے بری کیا جاتا ہے۔"],
  ["urdu-order", "درخواست ضمانت بعد از گرفتاری منظور کی جاتی ہے بشرطیکہ ملزم مچلکہ جمع کرائے۔"],
  ["urdu-order", "عدالت ہذا کو اس مقدمہ کی سماعت کا اختیار حاصل نہیں ہے۔"],
  ["urdu-order", "دستاویز پر گواہان کے دستخط موجود نہیں ہیں۔"],
  ["urdu-order", "حکم امتناعی کی درخواست خارج کی جاتی ہے۔"],
  // Urdu: tax, service, banking, rent and notices
  ["urdu-tax", "محکمہ انکم ٹیکس نے گوشوارہ جمع نہ کرانے پر جرمانہ عائد کیا۔"],
  ["urdu-service", "سرکاری ملازم کو شوکاز نوٹس جاری کیے بغیر ملازمت سے برطرف کر دیا گیا۔"],
  ["urdu-banking", "بینک نے قرض کی عدم ادائیگی پر رہن شدہ جائیداد نیلام کرنے کی کارروائی شروع کی۔"],
  ["urdu-rent", "کرایہ دار نے کرایہ کی رقم عدالت میں جمع کرانے سے انکار کیا۔"],
  ["urdu-rent", "مالک مکان نے ذاتی ضرورت کی بنیاد پر بے دخلی کی درخواست دی۔"],
  ["urdu-notice", "قانونی نوٹس کا کوئی جواب موصول نہیں ہوا۔"],
]
